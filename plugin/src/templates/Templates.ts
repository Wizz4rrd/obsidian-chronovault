import { moment, normalizePath, Notice, TFile } from "obsidian";
import type ChronoVaultPlugin from "../../main";
import { deckCode, toCodeBlock } from "../data/DeckExport";
import { allowedSyndicates } from "../data/DeckRules";
import { MatchFormat, ROUNDS_BLOCK } from "../data/tournament";
import { Deck } from "../data/types";
import { fillTemplate } from "./fillTemplate";

export type TemplateKind = "deck" | "tournament";

export const TEMPLATE_FILE_NAMES: Record<TemplateKind, string> = {
	deck: "Deck.md",
	tournament: "Tournament report.md",
};

/** Obsidian's moment, for core Templates date formats (its typings don't declare the call). */
const clock = moment as unknown as (input?: string, format?: string, strict?: boolean) => { isValid(): boolean; format(pattern: string): string };

/** The setting holding each note type's chosen template note (a path, "" for none). */
export const TEMPLATE_SETTINGS = { deck: "deckTemplate", tournament: "tournamentTemplate" } as const;

/**
 * Built-in note templates. Users can replace them with a note of their own:
 * the one chosen in the settings for that note type (from anywhere in the
 * vault), else a file with the name in TEMPLATE_FILE_NAMES in the template
 * folder. Obsidian's core Templates placeholders work too (see fillTemplate). Placeholders: {{name}} {{date}} {{deck}} {{code}} {{divers}}
 * {{syndicates}}, and for tournament reports {{event}} {{format}} {{roundCount}}
 * {{decks}} {{deckLinks}} {{decklists}} {{rounds}} ({{deckLink}} is the first deck).
 * {{rounds}} is the live view of the event's games (a chrono-matches block):
 * the games are kept in the match log, the plugin never edits a report's body.
 */
export const DEFAULT_TEMPLATES: Record<TemplateKind, string> = {
	deck: `---
type: chrono-deck
deck: "{{name}}"
syndicates: [{{syndicates}}]
divers: [{{divers}}]
code: {{code}}
created: {{date}}
status: testing
---
# {{name}}

{{deck}}
## Game plan
-

## Mulligan
Keep:
-

## Key cards & combos
-

## Matchups
How to play against each syndicate or deck. Results go in the match tracker.

| Against | Notes |
| --- | --- |
|  |  |

## Results
\`\`\`chrono-matches
\`\`\`

## Changelog
- {{date}} — created
`,
	tournament: `---
type: chrono-tournament
event: "{{event}}"
date: {{date}}
format: {{format}}
rounds: {{roundCount}}
decks: [{{decks}}]
record: 0-0
placement:
---
# {{name}}

**Event:** {{event}}
**Date:** {{date}}
**Format:** {{format}}
**Decks:** {{deckLinks}}

## Decklists
{{decklists}}
## Rounds
{{rounds}}

## Takeaways
- What worked:
- What didn't:
- Changes for next time:
`,
};

/** A deck brought to a tournament: the link to its note and its first deck block. */
export interface TournamentDeck {
	link: string;
	deck?: Deck;
}

export interface TemplateVars {
	name: string;
	deck?: Deck;
	event?: string;
	/** YYYY-MM-DD; today when not given. */
	date?: string;
	format?: MatchFormat;
	rounds?: number;
	decks?: TournamentDeck[];
}

export class NoteTemplates {
	constructor(private plugin: ChronoVaultPlugin) {}

	async render(kind: TemplateKind, vars: TemplateVars): Promise<string> {
		const template = (await this.readUserTemplate(kind)) ?? DEFAULT_TEMPLATES[kind];
		const cards = this.plugin.cards;
		const decks = vars.decks ?? [];
		// Older custom templates use {{deck}} / {{deckLink}}: the first deck.
		const deck = vars.deck ?? decks[0]?.deck;
		let code = "";
		if (deck && deck.divers.length) {
			try {
				code = deckCode(deck);
			} catch {
				code = "";
			}
		}
		const values: Record<string, string> = {
			name: vars.name,
			date: vars.date || today(),
			deck: deck ? toCodeBlock(deck, cards) : "",
			code,
			divers: deck ? deck.divers.map((id) => yamlQuote(cards.getById(id)?.name ?? String(id))).join(", ") : "",
			syndicates: deck ? Array.from(allowedSyndicates(deck, cards)).join(", ") : "",
			deckLink: decks[0]?.link ?? "",
			event: vars.event ?? "",
			format: vars.format ?? "",
			decks: decks.map((d) => yamlQuote(d.link)).join(", "),
			deckLinks: decks.map((d) => d.link).join(", "),
			decklists: decks.map((d) => `### ${d.link}\n${d.deck ? toCodeBlock(d.deck, cards) : ""}`).join("\n"),
			roundCount: vars.rounds ? String(vars.rounds) : "",
			rounds: ROUNDS_BLOCK,
		};
		const date = clock(values.date, "YYYY-MM-DD", true);
		return fillTemplate(template, values, (pattern, which) => (which === "date" && date.isValid() ? date : clock()).format(pattern));
	}

	/**
	 * The user's template for `kind`: the note chosen in the settings, else the
	 * file named after the note type in the template folder; null for the built-in one.
	 * A chosen note that no longer exists falls back to the built-in template, with a notice.
	 */
	private async readUserTemplate(kind: TemplateKind): Promise<string | null> {
		const chosen = this.plugin.settings[TEMPLATE_SETTINGS[kind]].trim();
		if (chosen) {
			const file = this.plugin.app.vault.getFileByPath(normalizePath(chosen));
			if (file) return this.plugin.app.vault.read(file);
			new Notice(`ChronoVault: the template note “${chosen}” was not found, so the built-in template was used. Pick another one in the settings.`);
			return null;
		}
		const folder = this.plugin.settings.templateFolder.trim();
		if (!folder) return null;
		const file = this.plugin.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${TEMPLATE_FILE_NAMES[kind]}`));
		return file instanceof TFile ? this.plugin.app.vault.read(file) : null;
	}

	/** Create a note in the configured folder and open it (unless `open` is false). */
	async createNote(kind: TemplateKind, vars: TemplateVars, subfolder: string, open = true): Promise<TFile | null> {
		try {
			const body = await this.render(kind, vars);
			const folder = normalizePath([this.plugin.settings.notesFolder.trim(), subfolder].filter(Boolean).join("/"));
			if (folder && folder !== "/" && !this.plugin.app.vault.getAbstractFileByPath(folder)) {
				await this.plugin.app.vault.createFolder(folder);
			}
			const base = sanitizeFileName(vars.name) || "Untitled";
			const path = await uniquePath(this.plugin, folder, base);
			const file = await this.plugin.app.vault.create(path, body);
			if (open) await this.plugin.app.workspace.getLeaf("tab").openFile(file);
			return file;
		} catch (err) {
			new Notice(`ChronoVault: could not create note — ${(err as Error).message}`);
			return null;
		}
	}

	createDeckNote(deck: Deck, open = true): Promise<TFile | null> {
		return this.createNote("deck", { name: deck.name || "Untitled deck", deck }, "Decks", open);
	}

	createTournamentNote(event: string, date: string, format: MatchFormat, rounds: number, decks: TournamentDeck[]): Promise<TFile | null> {
		const day = date || today();
		return this.createNote("tournament", { name: `${day} ${event}`, event, date: day, format, rounds, decks }, "Tournaments");
	}
}

function yamlQuote(s: string): string {
	return JSON.stringify(s);
}

export function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}

async function uniquePath(plugin: ChronoVaultPlugin, folder: string, base: string): Promise<string> {
	const prefix = folder && folder !== "/" ? `${folder}/` : "";
	let candidate = normalizePath(`${prefix}${base}.md`);
	for (let i = 1; await plugin.app.vault.adapter.exists(candidate); i++) {
		candidate = normalizePath(`${prefix}${base} (${i}).md`);
	}
	return candidate;
}

/** Local date as YYYY-MM-DD. */
export function today(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
