import { EmbedBuilder } from "discord.js";

const DEFAULT_COLOR = "#FFD700"; // arany sárga, ha nincs EMBED_COLOR

const embedColor = () => (process.env.EMBED_COLOR || DEFAULT_COLOR);

export const errorEmbed = (message: string) => {
  return {
    embeds: [
      new EmbedBuilder()
        .setDescription(`❌ | ${message}`)
        .setColor(embedColor()),
    ],
  };
};

export const successEmbed = (message: string) => {
  return {
    embeds: [
      new EmbedBuilder()
        .setDescription(`✅ | ${message}`)
        .setColor(embedColor()),
    ],
  };
};

export const replyEmbed = (message: string) => {
  return {
    embeds: [
      new EmbedBuilder()
        .setDescription(message)
        .setColor(embedColor()),
    ],
  };
};

export const generateId = () => {
  return Math.random().toString(36).slice(2, 12);
};

export const generateEmbeds = ({
  entries,
  generateEmbed,
  generateEntry,
}: {
  entries: any[];
  generateEmbed: (idx: number) => EmbedBuilder;
  generateEntry: (entry: any) => string;
}) => {
  const embeds: EmbedBuilder[] = [];

  entries.forEach((entry) => {
    const entryContent = generateEntry(entry);

    // kell-e új embed (ha még nincs, vagy túl hosszú lenne a leírás)
    const needNew =
      embeds.length === 0 ||
      ((embeds.at(-1)?.data?.description?.length ?? 0) + entryContent.length) >= 2048;

    if (needNew) {
      const newEmbed = generateEmbed(embeds.length);
      // biztos legyen string a description kezdőértéke
      if (typeof newEmbed.data.description !== "string") {
        newEmbed.setDescription("");
      }
      embeds.push(newEmbed);
    }

    const lastEmbed = embeds.at(-1)!;
    const current = lastEmbed.data.description ?? "";
    lastEmbed.setDescription(current + entryContent);
  });

  return embeds;
};
