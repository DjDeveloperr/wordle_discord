import { harmony, sqlite } from "../deps.ts";
import * as words from "./words.ts";
import * as emoji from "./emoji.ts";
import config from "../config.json" assert { type: "json" };

export const COMMANDS: harmony.ApplicationCommandPartial[] = [
  {
    name: "wordle",
    description: "Start playing today's Wordle!",
    options: [
      {
        name: "hard",
        description: "Hard mode toggle (default: off)",
        required: false,
        type: "BOOLEAN",
      },
    ],
  },
  {
    name: "stats",
    description: "View your Wordle stats!",
  },
  {
    name: "guess",
    description: "Start guessing the word!",
    options: [
      {
        name: "word",
        description: "Your guess. Watch out for autocompletions!",
        required: true,
        type: "STRING",
        autocomplete: true,
      },
    ],
  },
];

// 2/10/2022, it was Wordle 236
const OFFSET_DATE = 1644451200000;
const OFFSET_ID = 236;

export const TODAY = () => {
  const diff = Date.now() - OFFSET_DATE;
  return OFFSET_ID + Math.floor(diff / (1000 * 60 * 60 * 24));
};

export function calcNextWordle() {
  return Math.floor(
    (OFFSET_DATE + (TODAY() + 1 - OFFSET_ID) * 1000 * 60 * 60 * 24) / 1000,
  );
}

export function nextWordle() {
  const date = calcNextWordle();
  return `<t:${date}:R>`;
}

export interface Game {
  id: number;
  hard: boolean;
  guesses: string[];
  interaction: harmony.ApplicationCommandInteraction;
}

export function makeWordle(
  word: string,
  guesses: string[],
  spoilerFree = false,
) {
  return guesses.map((guess) => {
    return guess.split("").map((letter, i) => {
      let type: string;
      if (letter === word[i]) {
        type = "CORRECT";
      } else if (word.includes(letter)) {
        type = "ALMOSTCORRECT";
      } else {
        type = "INCORRECT";
      }
      if (spoilerFree) {
        return (emoji as any)[type];
      } else {
        return emoji
          .WORDS[`${type}_${letter.toUpperCase()}` as keyof typeof emoji.WORDS];
      }
    }).join("");
  }).join("\n");
}

export function gameToString(game: Game, ended?: number) {
  return `Wordle ${game.id}${game.hard ? "*" : ""} ${
    ended
      ? (ended === 2 ? "X/6" : `${game.guesses.length}/6`)
      : `${game.guesses.length}?/6\nPlay using \`/guess\`!`
  }\n\n${makeWordle(words.daily[game.id], game.guesses)}`.trim();
}

export const MESSAGES = {
  unknown_error: "Unknown Error!",
  not_playing: "You're not playing the game!",
  type_something: "Start typing your Guess!",
  continue: "Continue typing a 5 letter word...",
  invalid_char: "Your guess contains invalid characters!",
  too_long: "Word must be of exactly 5 letters!",
  unknown_word: "The word seems unknown!",
};

export function autocomplete(
  i: harmony.AutocompleteInteraction,
  message: keyof typeof MESSAGES,
) {
  return i.autocomplete([
    {
      name: MESSAGES[message],
      value: message,
    },
  ]);
}

export type WordleUser = {
  id: string;
  current_streak: number;
  max_streak: number;
  played: number;
  won: number;
  guesses: string;
  last_played: string;
};

export function makeGuessesChart(
  guesses: Record<string, number>,
  lastGuesses: number,
) {
  const guessMap = new Map<number, number>();
  let res: string[] = [];

  for (let i = 1; i <= 6; i++) {
    guessMap.set(i, guesses[i] || 0);
  }

  const max = Math.max(...guessMap.values());

  for (const [guess, count] of guessMap.entries()) {
    const em = guess === lastGuesses ? emoji.CORRECT : emoji.INCORRECT;
    res.push(
      `\`${guess}\` ${em.repeat(Math.floor(count / max * 10))} ${count}`,
    );
  }

  return res.join("\n");
}

export class WordleBot extends harmony.Client {
  db: sqlite.Database;
  games = new Map<string, Game>();

  constructor() {
    super({
      token: config.token,
      intents: [],
    });

    this.db = new sqlite.Database(
      new URL("../database.sqlite", import.meta.url),
    );

    this.db.execute("pragma journal_mode = WAL");
    this.db.execute("pragma synchronous = normal");
    this.db.execute("pragma temp_store = memory");

    this.db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(20),
        current_streak INTEGER,
        max_streak INTEGER,
        played INTEGER,
        won INTEGER,
        guesses VARCHAR,
        last_played INTEGER
      )
    `);
  }

  getWordleUser(id: string): WordleUser | undefined {
    return this.db.queryObject<WordleUser>(
      `SELECT * FROM users WHERE id = ?`,
      id,
    )[0];
  }

  updateWordleUser(id: string, wordle: number, guesses: number, win: boolean) {
    const current = this.getWordleUser(id);
    if (!current) {
      this.db.execute(
        `INSERT INTO users (
          id,
          current_streak,
          max_streak,
          played,
          won,
          guesses,
          last_played
        ) VALUES (
          ?, 1, 1, 1, ${win ? 1 : 0}, ?, ?
        )`,
        id,
        JSON.stringify({
          [guesses]: win ? 1 : 0,
        }),
        JSON.stringify({
          id: wordle,
          guesses,
          win,
        }),
      );
    } else {
      const currentGuesses = JSON.parse(current.guesses);
      currentGuesses[guesses] = (currentGuesses[guesses] || 0) + (win ? 1 : 0);
      this.db.execute(
        `UPDATE users SET
          current_streak = ${win ? current.current_streak + 1 : 1},
          max_streak = ${
          win
            ? Math.max(current.max_streak, current.current_streak + 1)
            : current.max_streak
        },
          played = played + 1,
          won = won + ${win ? 1 : 0},
          guesses = ?,
          last_played = ?
        WHERE id = ?`,
        JSON.stringify(currentGuesses),
        JSON.stringify({
          id: wordle,
          guesses,
          win,
        }),
        id,
      );
    }
  }

  hasPlayedToday(id: string, wordle: number) {
    const user = this.getWordleUser(id);
    if (!user) return false;
    const last = JSON.parse(user.last_played);
    return last.id >= wordle;
  }

  async syncCommands(guild?: string) {
    await this.interactions.commands.bulkEdit(COMMANDS, guild);
  }

  @harmony.slash()
  wordle(i: harmony.ApplicationCommandInteraction) {
    const today = TODAY();

    if (this.hasPlayedToday(i.user.id, today)) {
      return i.reply(
        `You've already played today! Next Wordle: ${nextWordle()}`,
        { ephemeral: true },
      );
    }

    if (!words.daily[today]) {
      return i.reply("I've run out of words!", { ephemeral: true });
    }

    if (this.games.has(i.user.id)) {
      const game = this.games.get(i.user.id)!;
      game.interaction = i;
      return i.reply({
        content: gameToString(game),
        ephemeral: true,
      });
    }

    const hard = i.option<any>("hard") ?? false;

    const game = {
      id: today,
      guesses: [],
      hard,
      interaction: i,
    };

    this.games.set(i.user.id, game);

    return i.reply({
      content: gameToString(game),
      ephemeral: true,
    });
  }

  @harmony.autocomplete("guess", "word")
  guessWord(i: harmony.AutocompleteInteraction) {
    const value = i.focusedOption.value! as string;
    if (value === undefined) {
      return autocomplete(i, "unknown_error");
    }

    const game = this.games.get(i.user.id);
    if (!game) {
      return autocomplete(i, "not_playing");
    }

    if (value === "") {
      return autocomplete(i, "type_something");
    }

    if (!/^[a-zA-Z]+$/.test(value)) {
      return autocomplete(i, "invalid_char");
    }

    if (value.length < 5) {
      return autocomplete(i, "continue");
    }

    if (value.length > 5) {
      return autocomplete(i, "too_long");
    }

    if (value.length === 5) {
      const word = value.toLowerCase();

      if (!words.daily.includes(word) && !words.others.includes(word)) {
        return autocomplete(i, "unknown_word");
      }

      return i.autocomplete([
        {
          name: `Submit "${word}"?`,
          value: word,
        },
      ]);
    }

    return autocomplete(i, "unknown_error");
  }

  @harmony.slash()
  guess(i: harmony.ApplicationCommandInteraction) {
    const word = i.option<string>("word");
    if (word in MESSAGES) {
      return i.reply(MESSAGES[word as keyof typeof MESSAGES], {
        ephemeral: true,
      });
    } else if (word.length === 5) {
      const game = this.games.get(i.user.id);
      if (!game) {
        return i.reply(MESSAGES.not_playing, { ephemeral: true });
      }

      const guess = word.toLowerCase();

      if (!words.daily.includes(guess) && !words.others.includes(guess)) {
        return i.reply(MESSAGES.unknown_word, { ephemeral: true });
      }

      game.guesses.push(guess);

      const ended = guess === words.daily[game.id]
        ? 1
        : game.guesses.length >= 6
        ? 2
        : 0;

      if (ended !== 0) {
        this.games.delete(i.user.id);
        this.updateWordleUser(
          i.user.id,
          game.id,
          game.guesses.length,
          ended === 1,
        );
      }

      const response = {
        content: gameToString(game, ended),
        ephemeral: true,
        components: ended === 0 ? [] : [
          {
            type: "ACTION_ROW" as const,
            components: [
              {
                type: "BUTTON" as const,
                label: "Share",
                style: "BLURPLE" as const,
                customID: `share:${ended},${game.id},${game.hard},${
                  words.daily[game.id]
                },${game.guesses.join(",")}`,
              },
            ],
          },
        ],
      };
      return game.interaction.editResponse(response).then(() => {
        return i.reply(`Guessed \`${guess}\`!`, { ephemeral: true });
      }, () => {
        // Maybe it timed out or something (15 min limit).
        game.interaction = i;
        return i.reply(response);
      });
    } else {
      return i.reply("Word is too short! It must contain exactly 5 letters.", {
        ephemeral: true,
      });
    }
  }

  @harmony.event()
  interactionCreate(i: harmony.Interaction) {
    if (i.isMessageComponent()) {
      if (i.customID.startsWith("share:")) {
        const [ended, id, hard, word, ...guesses] = i.customID.slice(6).split(
          ",",
        );

        return i.reply(
          `<@${i.user.id}>'s Wordle ${id} ${
            ended === "2" ? "X/6" : `${guesses.length}/6`
          }${hard === "true" ? "*" : ""}\n\n${makeWordle(word, guesses, true)}`,
        );
      }
    }
  }

  @harmony.slash()
  stats(i: harmony.ApplicationCommandInteraction) {
    const user = this.getWordleUser(i.user.id);
    if (!user) {
      return i.reply(
        "You haven't played Wordle! Get started using `/wordle`.",
        {
          ephemeral: true,
        },
      );
    }

    const today = TODAY();
    const last = JSON.parse(user.last_played);

    return i.reply(
      `**Played**: ${user.played}\n**Win %**: ${
        (user.won / user.played * 100).toFixed(1)
      }\n**Current Streak**: ${user.current_streak}\n**Max Streak**: ${user.max_streak}\n\n**Guess distributions**\n${
        makeGuessesChart(
          JSON.parse(user.guesses),
          last.guesses,
        )
      }\n\n**Next Wordle**: ${
        today > last.id ? "Available now!" : nextWordle()
      }`,
      { ephemeral: true },
    );
  }
}
