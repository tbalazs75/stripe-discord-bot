import { Client, Guild, GuildMember } from "discord.js";

type MembershipState = "active" | "inactive";

const env = (k: string) => process.env[k] ?? "";

const GUILD_ID = env("DISCORD_GUILD_ID") || env("GUILD_ID");
const PAYING_ROLE_ID = env("PAYING_ROLE_ID") || env("DISCORD_ROLE_ID");
const LIFETIME_ROLE_ID = env("LIFETIME_PAYING_ROLE_ID");
const UNKNOWN_ROLE_ID = env("UNKNOWN_ROLE_ID");
const LOGS_CHANNEL_ID = env("LOGS_CHANNEL_ID");

// opcionális: vesszővel elválasztva adj meg role ID-ket, amiket SOHA ne vegyünk le (pl. admin/mod)
// KEEP_ROLE_IDS="123,456,789"
const KEEP_ROLE_IDS = (env("KEEP_ROLE_IDS") || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function filterExistingRoleIds(guild: Guild, ids: (string|undefined)[]) {
  const set = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (guild.roles.cache.has(id)) set.add(id);
  }
  return [...set];
}

async function ensureGuild(client: Client): Promise<Guild> {
  if (!GUILD_ID) throw new Error("GUILD_ID/DISCORD_GUILD_ID hiányzik az env-ből.");
  return client.guilds.fetch(GUILD_ID);
}

async function fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null; // lehet, hogy már kilépett
  }
}

/**
 * Egységes, idempotens role beállítás:
 * - "active": keep + PAYING (+ megtartjuk a már meglévő LIFETIME-ot) – és levesszük az UNKNOWN-t
 * - "inactive": keep + UNKNOWN – MINDENT MÁST törlünk (paying, lifetime, extra csatorna rangok stb.)
 */
export async function applyMembershipState(
  client: Client,
  userId: string,
  state: MembershipState,
  opts?: { reason?: string; assignLifetime?: boolean } // assignLifetime: akkor add LIFETIME-ot is aktívnál
) {
  const guild = await ensureGuild(client);
  const member = await fetchMember(guild, userId);
  if (!member) return;

  // sose próbáljuk az @everyone-t állítani – a Discord kezeli automatikusan
  const keep = new Set<string>(filterExistingRoleIds(guild, KEEP_ROLE_IDS));

  // ha aktív, a végső halmaz:
  if (state === "active") {
    const finalRoles = new Set<string>(keep);
    // fizetős role kötelező, ha van
    filterExistingRoleIds(guild, [PAYING_ROLE_ID]).forEach(id => finalRoles.add(id));

    // Lifetime: vagy ha már VAN neki, vagy ha kifejezetten kérjük az opts.assignLifetime-t
    const memberHasLifetime = LIFETIME_ROLE_ID && member.roles.cache.has(LIFETIME_ROLE_ID);
    if (memberHasLifetime || opts?.assignLifetime) {
      filterExistingRoleIds(guild, [LIFETIME_ROLE_ID]).forEach(id => finalRoles.add(id));
    }

    // biztosan NE maradjon rajta az Ismeretlen
    const toSet = filterExistingRoleIds(guild, [...finalRoles]);
    await member.roles.set(toSet, opts?.reason ?? "membership: ACTIVE → set final roles");

  } else {
    // INACTIVE: mindent wipe-olunk, kivéve a keep + UNKNOWN
    const finalRoles = new Set<string>(keep);
    filterExistingRoleIds(guild, [UNKNOWN_ROLE_ID]).forEach(id => finalRoles.add(id));

    const toSet = filterExistingRoleIds(guild, [...finalRoles]);
    await member.roles.set(toSet, opts?.reason ?? "membership: INACTIVE → wipe to UNKNOWN");
  }

  // opcionális log
  if (LOGS_CHANNEL_ID && guild.channels.cache.has(LOGS_CHANNEL_ID)) {
    const ch = guild.channels.cache.get(LOGS_CHANNEL_ID);
    if (ch?.isTextBased()) {
      const now = new Date().toISOString();
      const tag = member.user?.tag ?? userId;
      ch.send(`[${now}] ${tag} → ${state.toUpperCase()} | roles set (${opts?.reason ?? ""})`).catch(() => {});
    }
  }
}
