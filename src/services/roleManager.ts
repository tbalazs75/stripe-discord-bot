import { Client, Guild, GuildMember, TextChannel } from "discord.js";

export type MembershipState = "active" | "inactive";

const env = (k: string) => process.env[k] ?? "";

const GUILD_ID = env("DISCORD_GUILD_ID") || env("GUILD_ID");
const PAYING_ROLE_ID = env("PAYING_ROLE_ID") || env("DISCORD_ROLE_ID");
const LIFETIME_ROLE_ID = env("LIFETIME_PAYING_ROLE_ID");
const UNKNOWN_ROLE_ID = env("UNKNOWN_ROLE_ID");
const LOGS_CHANNEL_ID = env("LOGS_CHANNEL_ID");

// KEEP_ROLE_IDS="123,456,789"
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

function managedRoleIds(guild: Guild): string[] {
  // A bot által MENEDZSELT szerepek: CSAK ezekhez nyúlunk.
  return filterExistingRoleIds(guild, [PAYING_ROLE_ID, LIFETIME_ROLE_ID, UNKNOWN_ROLE_ID]);
}

// KEEP-ből kiszűrjük a menedzselt szerepeket, hogy véletlen se “védjük” a bot saját rangjait.
function sanitizeKeep(guild: Guild) {
  const managed = new Set(managedRoleIds(guild));
  return filterExistingRoleIds(
    guild,
    RAW_KEEP_ROLE_IDS.filter((id) => !managed.has(id))
  );
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
 * Egységes, idempotens role frissítés DIFF alapon:
 * - Soha nem használ roles.set-et.
 * - CSAK a bot által MENEDZSELT szerepekhez nyúl (PAYING / LIFETIME / UNKNOWN).
 * - Minden más szerepet érintetlenül hagy.
 *
 * Állapotlogika:
 * - "active": PAYING fel, UNKNOWN le; LIFETIME fel, ha már rajta volt VAGY assignLifetime = true, különben le.
 * - "inactive": PAYING le, LIFETIME le, UNKNOWN fel.
 *
 * KEEP_ROLE_IDS: extra “védett” szerepek – de a nem menedzselt szerepek amúgy is megmaradnak.
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

  const managed = new Set(managedRoleIds(guild));
  const keep = new Set<string>(sanitizeKeep(guild));

  // Jelenlegi szerepek (@everyone-t mindig megőrzi a Discord, ID-je = guild.id)
  const current = new Set(member.roles.cache.map((r) => r.id));

  // PRESERVED: minden, ami NEM managed VAGY kifejezetten KEEP
  const preserved = new Set(
    [...current].filter((id) => !managed.has(id) || keep.has(id))
  );

  // Célszerepek felépítése a preserved alapján
  const target = new Set(preserved);

  // Helper-ek: biztonságos add/remove a target készlethez
  const addIfExists = (id?: string) => {
    if (!id) return;
    if (guild.roles.cache.has(id)) target.add(id);
  };
  const deleteIfExists = (id?: string) => {
    if (!id) return;
    target.delete(id);
  };

  // Állapot alkalmazása csak a MENEDZSELT szerepekre
  if (state === "active") {
    // Unknown le, Paying fel
    deleteIfExists(UNKNOWN_ROLE_ID);
    addIfExists(PAYING_ROLE_ID);

    // Lifetime kezelése
    const memberHasLifetime = !!(LIFETIME_ROLE_ID && current.has(LIFETIME_ROLE_ID));
    if (LIFETIME_ROLE_ID) {
      if (memberHasLifetime || opts?.assignLifetime) addIfExists(LIFETIME_ROLE_ID);
      else deleteIfExists(LIFETIME_ROLE_ID);
    }
  } else {
    // inactive: Paying le, Lifetime le, Unknown fel
    deleteIfExists(PAYING_ROLE_ID);
    deleteIfExists(LIFETIME_ROLE_ID);
    addIfExists(UNKNOWN_ROLE_ID);
  }

  // Különbség számítás – CSAK a managed szerepekhez nyúlunk!
  const toAdd = [...target].filter((id) => !current.has(id) && managed.has(id));
  const toRemove = [...current].filter((id) => !target.has(id) && managed.has(id));

  // Végrehajtás – nincs roles.set, csak add/remove a különbségekre
  try {
    for (const id of toAdd) {
      await member.roles.add(id, opts?.reason ?? "membership: add managed role").catch((e) => {
        throw e;
      });
    }
    for (const id of toRemove) {
      await member.roles.remove(id, opts?.reason ?? "membership: remove managed role").catch((e) => {
        throw e;
      });
    }
  } catch (err: any) {
    // tipikus ok: bot szerep alacsonyan van a hierarchiában / hiányzó Manage Roles
    await logToChannel(guild, `⚠️ Role update failed for <@${userId}>: ${err?.message ?? err}`);
    throw err;
  }

  // Opcionális plusz biztosítás: ha aktív állapotban mégis rajta maradt UNKNOWN cache/hierarchy anomália miatt
  if (state === "active" && UNKNOWN_ROLE_ID && member.roles.cache.has(UNKNOWN_ROLE_ID)) {
    await member.roles.remove(UNKNOWN_ROLE_ID).catch(() => {});
  }

  // Napló
  const now = new Date().toISOString();
  const tag = member.user?.tag ?? userId;
  await logToChannel(
    guild,
    `[${now}] ${tag} → ${state.toUpperCase()} | roles updated +[${toAdd.join(",")}] -[${toRemove.join(",")}] ${
      opts?.reason ? `(${opts.reason})` : ""
    }`
  );
}
