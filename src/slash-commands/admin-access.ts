import { ChatInputCommandInteraction, PermissionsBitField, ApplicationCommandOptionType } from "discord.js";
import { errorEmbed, successEmbed } from "../util";
import { Postgres, DiscordCustomer } from "../database";

export const commands = [
  {
    name: "admin-access",
    description: "Give admin access to a user",
    options: [
      {
        name: "enable",
        description: "Enable access for the user",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "user",
            description: "The user you want to give access to",
            type: ApplicationCommandOptionType.User,
            required: true,
          },
        ],
      },
      {
        name: "disable",
        description: "Disable access for the user",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "user",
            description: "The user you want to remove access from",
            type: ApplicationCommandOptionType.User,
            required: true,
          },
        ],
      },
    ],
  },
];

export const run = async (interaction: ChatInputCommandInteraction) => {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    return void interaction.followUp(
      errorEmbed("This command needs privileged access and can only be used by administrators.")
    );
  }

  const subCommand = interaction.options.getSubcommand();
  const user = interaction.options.getUser("user", true);

  const userCustomer = await Postgres.getRepository(DiscordCustomer).findOne({
    where: { discordUserId: user.id },
  });

  if (userCustomer) {
    await Postgres.getRepository(DiscordCustomer).update(userCustomer.id, {
      adminAccessEnabled: subCommand === "enable",
    });
  } else {
    await Postgres.getRepository(DiscordCustomer).insert({
      discordUserId: user.id,
      adminAccessEnabled: subCommand === "enable",
    });
  }

  const member = interaction.guild?.members.cache.get(user.id);
  const roleId = process.env.ADMIN_ROLE_ID!;

  if (subCommand === "enable") {
    if (member) await member.roles.add(roleId);
  } else {
    if (member) await member.roles.remove(roleId);
  }

  return void interaction.followUp(
    successEmbed(`Successfully ${subCommand === "enable" ? "enabled" : "disabled"} access for ${user.tag}.`)
  );
};
