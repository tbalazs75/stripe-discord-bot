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
  .map(s => s.trim())
  .filter(Boolean);

function requireEnv(name: string, value?: string) {
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function filterExistingRoleIds(guild: Guild, ids: (string|undefined)[]) {
  const set = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (guild.roles.cache.has(id)) set.add(id);
  }
  return [...set];
}

// Ne lehessen véletlenül PAYING/LIFETIME/UNKNOWN a keep-ben
function sanitizeKeep(guild: Guild) {
  const forbids = new Set([PAYING_ROLE_ID, LIFETIME_ROLE_ID, UNKNOWN_ROLE_ID].filter(Boolean));
  return filterExistingRoleIds(
    guild,
    RAW_KEEP_ROLE_IDS.filter(id => !forbids.has(id))
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
 * Egységes, idempotens role beállítás:
 * - "active": keep + PAYING (+ LIFETIME ha már volt vagy assignLifetime), UNKNOWN biztosan LE
 * - "inactive": keep + UNKNOWN, MINDEN MÁS LE
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

  const keep = new Set<string>(sanitizeKeep(guild));

  try {
    if (state === "active") {
      const finalRoles = new Set<string>(keep);

      // kötelező: fizetős
      filterExistingRoleIds(guild, [PAYING_ROLE_ID]).forEach(id => finalRoles.add(id));

      // Lifetime: ha már rajta van vagy explicit kérjük
      const memberHasLifetime = !!(LIFETIME_ROLE_ID && member.roles.cache.has(LIFETIME_ROLE_ID));
      if (memberHasLifetime || opts?.assignLifetime) {
        filterExistingRoleIds(guild, [LIFETIME_ROLE_ID]).forEach(id => finalRoles.add(id));
      }

      const toSet = filterExistingRoleIds(guild, [...finalRoles]);
      await member.roles.set(toSet, opts?.reason ?? "membership: ACTIVE → set final roles");

      // biztos-ami-biztos: ha UNKNOWN mégis rajta maradt (pl. cache/permission anomália), próbáljuk levenni
      if (UNKNOWN_ROLE_ID && member.roles.cache.has(UNKNOWN_ROLE_ID)) {
        await member.roles.remove(UNKNOWN_ROLE_ID).catch(() => {});
      }
    } else {
      // INACTIVE: keep + unknown
      const finalRoles = new Set<string>(keep);
      filterExistingRoleIds(guild, [UNKNOWN_ROLE_ID]).forEach(id => finalRoles.add(id));

      const toSet = filterExistingRoleIds(guild, [...finalRoles]);
      await member.roles.set(toSet, opts?.reason ?? "membership: INACTIVE → wipe to UNKNOWN");
    }
  } catch (err: any) {
    // tipikus ok: bot szerep alacsonyan van a hierarchiában / hiányzó Manage Roles
    await logToChannel(
      guild,
      `⚠️ Role update failed for <@${userId}>: ${err?.message ?? err}`
    );
    throw err;
  }

  // opcionális log
  const now = new Date().toISOString();
  const tag = member.user?.tag ?? userId;
  await logToChannel(
    guild,
    `[${now}] ${tag} → ${state.toUpperCase()} | roles set (${opts?.reason ?? ""})`
  );
}
