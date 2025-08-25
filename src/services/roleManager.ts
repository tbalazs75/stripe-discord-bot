import { Client, Guild, GuildMember, Role, TextChannel } from "discord.js";

export type MembershipState = "active" | "inactive";

const env = (k: string) => process.env[k] ?? "";

const GUILD_ID = env("DISCORD_GUILD_ID") || env("GUILD_ID");
const PAYING_ROLE_ID = env("PAYING_ROLE_ID") || env("DISCORD_ROLE_ID");  // "Tanítvány"
const LIFETIME_ROLE_ID = env("LIFETIME_PAYING_ROLE_ID");                 // opcionális "Lifetime"
const UNKNOWN_ROLE_ID = env("UNKNOWN_ROLE_ID");                          // "Ismeretlen"
const LOGS_CHANNEL_ID = env("LOGS_CHANNEL_ID");

// KEEP_ROLE_IDS="123,456,789"  (ezekhez SOHA ne nyúljon a bot – pl. admin/mod)
const RAW_KEEP_ROLE_IDS = (env("KEEP_ROLE_IDS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function requireEnv(name: string, value?: string) {
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function filterExistingRoleIds(guild: Guild, ids: (string | undefined)[]) {
  const set = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (guild.roles.cache.has(id)) set.add(id);
  }
  return [...set];
}

// A bot által ADDITÍVAN kezelt szerepek: ezekhez nyúlunk ACTIVE állapotban (diff)
function additiveManagedRoleIds(guild: Guild): string[] {
  return filterExistingRoleIds(guild, [PAYING_ROLE_ID, LIFETIME_ROLE_ID, UNKNOWN_ROLE_ID]);
}

// KEEP-ből szűrjük ki a bot-kezelt szerepeket (nehogy „védjük” a sajátot)
function sanitizeKeep(guild: Guild) {
  const managed = new Set(additiveManagedRoleIds(guild));
  return filterExistingRoleIds(
    guild,
    RAW_KEEP_ROLE_IDS.filter((id) => !managed.has(id))
  );
}

// Mely role-okat TUD a bot levenni? (hierarchia/permissions alapján)
function manageableRoleIds(guild: Guild): Set<string> {
  const ids = new Set<string>();
  guild.roles.cache.forEach((r: Role) => {
    if (r.editable) ids.add(r.id);
  });
  return ids;
}

async function ensureGuild(client: Client): Promise<Guild> {
  requireEnv("DISCORD_GUILD_ID / GUILD_ID", GUILD_ID);
  return client.guilds.fetch(GUILD_ID);
}

async function fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null; // lehet, hogy már kilépett
  }
}

async function logToChannel(guild: Guild, message: string) {
  if (!LOGS_CHANNEL_ID) return;
  const ch = await guild.channels.fetch(LOGS_CHANNEL_ID).catch(() => null);
  if (ch && ch.isTextBased()) {
    (ch as TextChannel).send({ content: message }).catch(() => {});
  }
}

/**
 * DIFF-alapú, biztonságos role frissítés:
 * - SOHA nem használ roles.set-et.
 *
 * Állapotok:
 *  - "active":
 *      - UNKNOWN le; PAYING fel; LIFETIME: fel ha már volt vagy assignLifetime, különben le.
 *      - MINDEN MÁS szerep érintetlen (extra hozzáférések megmaradnak).
 *  - "inactive":
 *      - UNKNOWN fel.
 *      - **FULL WIPE**: minden olyan szerepet eltávolítunk, amit a bot le tud venni (editable),
 *        KIVÉVE a KEEP_ROLE_IDS-ben lévőket és magát az UNKNOWN-t.
 *        (Az @everyone szerep eleve nem eltávolítható.)
 */
export async function applyMembershipState(
  client: Client,
  userId: string,
  state: MembershipState,
  opts?: { reason?: string; assignLifetime?: boolean }
) {
  const guild = await ensureGuild(client);
  const member = await fetchMember(guild, userId);
  if (!member) return;

  const managedAdditive = new Set(additiveManagedRoleIds(guild)); // PAYING/LIFETIME/UNKNOWN
  const keep = new Set<string>(sanitizeKeep(guild));              // védett (admin/mod)
  const manageable = manageableRoleIds(guild);                    // amit a bot le/fel tud venni

  // Jelenlegi szerepek (@everyone = guild.id)
  const current = new Set(member.roles.cache.map((r) => r.id));

  const toAdd: string[] = [];
  const toRemove: string[] = [];

  if (state === "active") {
    // --- ACTIVE: csak additív kezelt szerepekhez nyúlunk ---
    if (UNKNOWN_ROLE_ID && current.has(UNKNOWN_ROLE_ID) && manageable.has(UNKNOWN_ROLE_ID)) {
      toRemove.push(UNKNOWN_ROLE_ID);
    }
    if (PAYING_ROLE_ID && !current.has(PAYING_ROLE_ID) && manageable.has(PAYING_ROLE_ID)) {
      toAdd.push(PAYING_ROLE_ID);
    }
    if (LIFETIME_ROLE_ID && manageable.has(LIFETIME_ROLE_ID)) {
      const memberHasLifetime = current.has(LIFETIME_ROLE_ID);
      if (memberHasLifetime || opts?.assignLifetime) {
        if (!memberHasLifetime) toAdd.push(LIFETIME_ROLE_ID);
      } else {
        if (memberHasLifetime) toRemove.push(LIFETIME_ROLE_ID);
      }
    }
  } else {
    // --- INACTIVE: FULL WIPE mód ---
    // 1) garantáld az UNKNOWN-t
    if (UNKNOWN_ROLE_ID && !current.has(UNKNOWN_ROLE_ID) && manageable.has(UNKNOWN_ROLE_ID)) {
      toAdd.push(UNKNOWN_ROLE_ID);
    }

    // 2) távolíts el MINDENT, amit a bot tud, kivéve: UNKNOWN + KEEP + @everyone
    for (const id of current) {
      if (id === guild.id) continue; // @everyone
      if (UNKNOWN_ROLE_ID && id === UNKNOWN_ROLE_ID) continue; // maradjon Unknown
      if (keep.has(id)) continue; // védett (pl. admin/mod)

      if (manageable.has(id)) {
        toRemove.push(id);
      }
    }
  }

  // végrehajtás – nincs roles.set, csak add/remove
  try {
    for (const id of toAdd) {
      await member.roles.add(id, opts?.reason ?? "membership: add role");
    }
    for (const id of toRemove) {
      await member.roles.remove(id, opts?.reason ?? "membership: remove role");
    }
  } catch (err: any) {
    await logToChannel(guild, `⚠️ Role update failed for <@${userId}>: ${err?.message ?? err}`);
    throw err;
  }

  // extra biztosítás: ACTIVE esetén ne maradjon rajta UNKNOWN
  if (state === "active" && UNKNOWN_ROLE_ID && member.roles.cache.has(UNKNOWN_ROLE_ID) && manageable.has(UNKNOWN_ROLE_ID)) {
    await member.roles.remove(UNKNOWN_ROLE_ID).catch(() => {});
  }

  // napló
  const now = new Date().toISOString();
  const tag = member.user?.tag ?? userId;
  await logToChannel(
    guild,
    `[${now}] ${tag} → ${state.toUpperCase()} | roles updated +[${toAdd.join(",")}] -[${toRemove.join(",")}] ${
      opts?.reason ? `(${opts.reason})` : ""
    }`
  );
}
