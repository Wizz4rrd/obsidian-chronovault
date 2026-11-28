import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type ChronoVaultPlugin from "../../main";
import { DataSourceId } from "../data/DataSync";
import { BuilderDraft, emptyDeck } from "../ui/DeckBuilderView";
import { ConfirmModal } from "../ui/ConfirmModal";
import { CACHED_IMAGE_KB, CACHED_IMAGE_WIDTH, DownloadProgress, imageCache, ORIGINAL_IMAGE_KB } from "../utils/ImageCache";
import { imagesToSave } from "../utils/imageUrl";
import { TextPromptModal } from "../ui/TextPromptModal";

/** Full card render (frame, stats and text on the image) vs illustration only. */
export type CardImageStyle = "game" | "full";

export type DeckView = "grid" | "list";

/** Where saved card images go: a "ChronoVault" folder in the attachment folder, or the plugin folder. */
export type ImageFolder = "vault" | "plugin";

/** The card browser as a page (tab in the main area) or in the right sidebar. */
export type CardBrowserPlacement = "tab" | "sidebar";

/** A kind of game the match tracker can log, e.g. "Ladder". */
export interface MatchType {
	name: string;
	/** Games of this type are played in a tournament: they link to its report and have a round. */
	tournament: boolean;
}

export const DEFAULT_MATCH_TYPES: MatchType[] = [
	{ name: "Ladder", tournament: false },
	{ name: "Scrim", tournament: false },
	{ name: "Tournament", tournament: true },
];

export interface ChronoSettings {
	dataSource: DataSourceId;
	customDataUrl: string;
	/** Prefer framed card art (stats on image) or full-bleed illustration. */
	cardImageStyle: CardImageStyle;
	autoRefreshDays: number;
	/** Keep downloaded card images (see `imageFolder`). */
	cacheImages: boolean;
	imageFolder: ImageFolder;
	/** The folder the images were last saved in, to move them when it changes ("" = the plugin folder, before `imageFolder` existed). */
	imageCacheDir: string;
	lastSyncIso: string | null;
	/** Default rendering of ```chrono-deck blocks. */
	deckView: DeckView;
	hoverPreviews: boolean;
	/** Root folder for notes created by the plugin ("" = vault root). */
	notesFolder: string;
	/** Optional folder with user templates overriding the built-in ones. */
	templateFolder: string;
	/** Log deck builder saves in the deck note's Changelog section. */
	deckChangelog: boolean;
	/** Note the match tracker keeps games in ("" = "Match log.md" in the notes folder). */
	matchLog: string;
	/** Deck links in the match log show the deck's name ("[[Decks/Egg Novice|Egg Novice]]"). */
	matchLogDeckAlias: boolean;
	/** Types offered when logging a game, in this order. */
	matchTypes: MatchType[];
	cardBrowserPlacement: CardBrowserPlacement;
	/** Height of the card browser's filters, in % of the pane (the rest is the cards). */
	browserFiltersPercent: number;
	/** Deck builder state, persisted between sessions. */
	builderDraft: BuilderDraft;
}

export const DEFAULT_SETTINGS: ChronoSettings = {
	dataSource: "official",
	customDataUrl: "",
	cardImageStyle: "game",
	autoRefreshDays: 7,
	cacheImages: true,
	imageFolder: "vault",
	imageCacheDir: "",
	lastSyncIso: null,
	deckView: "grid",
	hoverPreviews: true,
	notesFolder: "ChronoCCG",
	templateFolder: "",
	deckChangelog: true,
	matchLog: "",
	matchLogDeckAlias: true,
	matchTypes: DEFAULT_MATCH_TYPES,
	cardBrowserPlacement: "tab",
	browserFiltersPercent: 42,
	builderDraft: { deck: emptyDeck() },
};

/** Keys of {@link ChronoSettings} bound to a declarative control. */
type ControlKey = "cardBrowserPlacement" | "dataSource" | "customDataUrl" | "autoRefreshDays" | "cardImageStyle" | "deckView" | "hoverPreviews" | "notesFolder" | "templateFolder" | "deckChangelog" | "matchLog" | "matchLogDeckAlias" | "imageFolder";

export class ChronoSettingsTab extends PluginSettingTab {
	/** Rows that show something derived from the settings (e.g. the images to download), redrawn when a setting changes. */
	private refreshers = new Set<() => void>();

	constructor(app: App, private plugin: ChronoVaultPlugin) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof ChronoSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings as unknown as Record<ControlKey, unknown>;
		s[key as ControlKey] = normalizeControlValue(key as ControlKey, value);
		await this.plugin.saveSettings();
		if (key === "cardBrowserPlacement") await this.plugin.setCardBrowserPlacement(value as CardBrowserPlacement);
		// The images move with the setting (and with the notes folder, for a relative attachment folder).
		if (key === "imageFolder" || key === "notesFolder") await imageCache.relocate();
		// "Custom data URL" is only shown for the custom source; each image style has its own images to download.
		this.refreshDomState();
		this.refreshers.forEach((refresh) => refresh());
	}

	getSettingDefinitions(): SettingDefinitionItem<ControlKey>[] {
		const s = this.plugin.settings;
		return [
			{
				type: "group",
				heading: "Card data",
				items: [
					{
						name: "Card data source",
						desc: "Where to pull the card database from.",
						control: {
							type: "dropdown",
							key: "dataSource",
							options: { bundled: "Bundled (offline seed)", official: "Official (playchrono.com)", custom: "Custom URL" },
						},
					},
					{
						name: "Custom data URL",
						desc: "JSON endpoint returning a card list or { cards: [...] }.",
						visible: () => s.dataSource === "custom",
						control: { type: "text", key: "customDataUrl", placeholder: "https://example.com/cards.json" },
					},
					{
						name: "Auto-refresh interval (days)",
						desc: "Re-download the card database when it is older than this. 0 disables auto-refresh.",
						control: { type: "number", key: "autoRefreshDays", min: 0, defaultValue: DEFAULT_SETTINGS.autoRefreshDays },
					},
					{
						name: "Refresh card database now",
						desc: "Downloads the card list again.",
						aliases: ["sync", "update cards"],
						render: (setting) => this.renderRefresh(setting),
					},
					{
						name: "Save card images",
						desc:
							`Download each card image once and keep a ${CACHED_IMAGE_WIDTH}px copy, so cards also show offline. ` +
							"When off, the full-size images (about 1.3 MB each) are loaded every time, and the saved ones are deleted.",
						aliases: ["cache", "offline"],
						render: (setting) => this.renderSaveImages(setting),
					},
					{
						name: "Card image folder",
						desc:
							'Attachments folder: a "ChronoVault" folder in your attachment folder (Settings → Files and links), so the images sync with the vault and devices with their own config folder share them. ' +
							"Plugin folder: in the plugin's own folder. Changing this moves the saved images.",
						aliases: ["attachments", "storage"],
						control: { type: "dropdown", key: "imageFolder", options: { vault: "Attachments folder", plugin: "Plugin folder" } },
					},
					{
						name: "Download all card images",
						desc: "Download every card image that isn't saved yet, so every card also shows offline.",
						aliases: ["offline", "cache"],
						render: (setting) => this.renderDownloadAll(setting),
					},
					{
						name: "Clear saved images",
						desc: "Delete the saved card images and icons.",
						aliases: ["cache"],
						render: (setting) => this.renderClearImages(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Display",
				items: [
					{
						name: "Card image style",
						desc: "In-game: framed card with cost, stats and rules text on the image. Full art: illustration only.",
						control: { type: "dropdown", key: "cardImageStyle", options: { game: "In-game (framed)", full: "Full art only" } },
					},
					{
						name: "Default deck view",
						desc: "How chrono-deck blocks render. Each block also has a grid/list toggle.",
						control: { type: "dropdown", key: "deckView", options: { grid: "Card grid", list: "Compact list" } },
					},
					{
						name: "Open card browser as",
						desc: "A page in the main area, or a pane in the right sidebar. An open card browser moves right away.",
						aliases: ["sidebar", "tab", "pane"],
						control: { type: "dropdown", key: "cardBrowserPlacement", options: { tab: "Page", sidebar: "Sidebar pane" } },
					},
					{
						name: "Hover previews",
						desc: "Show a large card image when hovering card names and tiles (desktop).",
						control: { type: "toggle", key: "hoverPreviews" },
					},
				],
			},
			{
				type: "group",
				heading: "Notes",
				items: [
					{
						name: "Notes folder",
						desc: "Deck notes and tournament reports are created in sub-folders of this folder. Empty = vault root.",
						control: { type: "folder", key: "notesFolder", placeholder: "ChronoCCG", includeRoot: true },
					},
					{
						name: "Template folder",
						desc:
							'Optional. "Deck.md" and "Tournament report.md" files in this folder replace the built-in templates. ' +
							"Placeholders: {{name}} {{date}} {{deck}} {{code}} {{divers}} {{syndicates}}; in tournament reports also " +
							"{{event}} {{format}} {{roundCount}} {{decks}} {{deckLinks}} {{decklists}} {{rounds}} (the live rounds of the event).",
						control: { type: "folder", key: "templateFolder", placeholder: "ChronoCCG/Templates" },
					},
					{
						name: "Default templates",
						desc: "Copy the built-in deck note and tournament report templates into the template folder, so you can edit them. Existing files are kept.",
						render: (setting) => {
							setting.addButton((b) =>
								b.setButtonText("Write templates").onClick(async () => {
									b.setDisabled(true);
									try {
										await this.plugin.writeDefaultTemplates();
									} finally {
										b.setDisabled(false);
									}
								}),
							);
						},
					},
					{
						name: "Log deck changes",
						desc:
							'When you save a deck note from the deck builder, add what changed (cards, Divers, name) to the note\'s "Changelog" section. ' +
							"Saves on the same day are merged into one line.",
						control: { type: "toggle", key: "deckChangelog" },
					},
				],
			},
			{
				type: "group",
				heading: "Match tracker",
				items: [
					{
						name: "Match log",
						desc: 'Note where the match tracker saves your games, as a table you can also edit by hand. Empty = "Match log.md" in the notes folder. Renaming this setting doesn\'t move existing games.',
						control: { type: "text", key: "matchLog", placeholder: "ChronoCCG/Match log.md" },
					},
					{
						name: "Deck names in the match log",
						desc: 'Write deck links with the deck\'s name, so the table shows "Egg Novice" instead of "Decks/Egg Novice". Games already in the log keep their links until you edit them.',
						control: { type: "toggle", key: "matchLogDeckAlias" },
					},
				],
			},
			{
				type: "list",
				heading: "Match types",
				emptyState: "No types: games are logged without one.",
				addItem: { name: "Add match type", action: () => this.promptMatchType() },
				onDelete: (i) => void this.changeMatchTypes((types) => types.splice(i, 1)),
				onReorder: (from, to) => void this.changeMatchTypes((types) => types.splice(to, 0, ...types.splice(from, 1))),
				items: s.matchTypes.map((t, i) => ({
					name: t.name,
					desc: t.tournament ? "Tournament: asks for the tournament report and the round." : "",
					aliases: ["ladder", "scrim", "tournament"],
					render: (setting: Setting) => {
						setting.addExtraButton((b) => b.setIcon("pencil").setTooltip("Rename").onClick(() => this.promptMatchType(i)));
						setting.addToggle((tg) =>
							tg
								.setTooltip("Tournament: games link to a tournament report and have a round")
								.setValue(t.tournament)
								.onChange((v) => void this.changeMatchTypes((types) => (types[i] = { ...types[i], tournament: v }))),
						);
					},
				})),
			},
		];
	}

	/** Change the match types, save them and redraw the list. */
	private async changeMatchTypes(change: (types: MatchType[]) => void): Promise<void> {
		const types = this.plugin.settings.matchTypes.slice();
		change(types);
		this.plugin.settings.matchTypes = types;
		await this.plugin.saveSettings();
		this.update();
	}

	/** Ask for a new type's name, or a new name for the type at `index`. Games already logged keep their type. */
	private promptMatchType(index?: number): void {
		const current = index === undefined ? undefined : this.plugin.settings.matchTypes[index];
		new TextPromptModal(this.app, {
			title: current ? `Rename “${current.name}”` : "New match type",
			placeholder: "e.g. Casual",
			value: current?.name,
			cta: current ? "Rename" : "Add",
			onSubmit: (value) => {
				const name = value.replace(/\s+/g, " ").replace(/\|/g, "/");
				const taken = this.plugin.settings.matchTypes.some((t, i) => i !== index && t.name.toLowerCase() === name.toLowerCase());
				if (taken) return void new Notice(`ChronoVault: there is already a “${name}” type.`);
				void this.changeMatchTypes((types) => {
					if (index === undefined) types.push({ name, tournament: false });
					else types[index] = { ...types[index], name };
				});
			},
		}).open();
	}

	/** Run `refresh` now and whenever a setting changes, until the row is torn down. */
	private keepFresh(refresh: () => void): () => void {
		refresh();
		this.refreshers.add(refresh);
		return () => this.refreshers.delete(refresh);
	}

	private renderRefresh(setting: Setting): () => void {
		const s = this.plugin.settings;
		const showStatus = () =>
			setting.setDesc(
				`Loaded cards: ${this.plugin.cards.size} • source: ${this.plugin.cards.source} • version: ${this.plugin.cards.version}` +
					(s.lastSyncIso ? ` • last sync: ${new Date(s.lastSyncIso).toLocaleString()}` : ""),
			);
		setting.addButton((b) =>
			b
				.setCta()
				.setButtonText("Refresh")
				.onClick(async () => {
					b.setDisabled(true).setButtonText("Refreshing…");
					try {
						await this.plugin.refreshCardDatabase();
						// New cards change what "Download all" has to download.
						this.refreshers.forEach((refresh) => refresh());
					} finally {
						b.setDisabled(false).setButtonText("Refresh");
					}
				}),
		);
		return this.keepFresh(showStatus);
	}

	private renderSaveImages(setting: Setting): void {
		const s = this.plugin.settings;
		setting.addToggle((t) =>
			t.setValue(s.cacheImages).onChange(async (v) => {
				if (v === s.cacheImages) return;
				const { files, bytes } = v ? { files: 0, bytes: 0 } : await imageCache.stats();
				if (v || !files) {
					s.cacheImages = v;
					await this.plugin.saveSettings();
					this.refreshers.forEach((refresh) => refresh());
					return;
				}
				new ConfirmModal(this.app, {
					title: "Stop saving card images",
					message:
						`This deletes the ${files} saved image${files === 1 ? "" : "s"} (${(bytes / 1024 / 1024).toFixed(1)} MB). ` +
						"Cards then load the full-size images (about 1.3 MB each) from the internet every time, and don't show offline.",
					cta: "Turn off and delete",
					warning: true,
					onConfirm: () => void this.stopSavingImages(),
					onCancel: () => t.setValue(true),
				}).open();
			}),
		);
	}

	private renderDownloadAll(setting: Setting): () => void {
		const s = this.plugin.settings;
		let images: { cards: string[]; icons: string[] } = { cards: [], icons: [] };
		let downloadBtn!: ButtonComponent;
		setting.addButton((b) => {
			downloadBtn = b;
			b.onClick(() => {
				if (imageCache.downloadProgress?.running) imageCache.cancelDownload();
				else void this.confirmDownloadAll(images);
			});
		});
		// Cards and syndicate icons are counted apart: "All 390 cards and 6 syndicate icons are saved."
		const describe = (savedCards: number, savedIcons: number): string => {
			if (!s.cacheImages) return 'Turn on "Save card images" first.';
			const { cards, icons } = images;
			if (!cards.length) return "No card data yet.";
			const missingCards = cards.length - savedCards;
			const missingIcons = icons.length - savedIcons;
			if (!missingCards && !missingIcons) return icons.length ? `All ${cards.length} cards and ${icons.length} syndicate icons are saved.` : `All ${cards.length} card images are saved.`;
			const saved = icons.length ? `${savedCards} of ${cards.length} cards and ${savedIcons} of ${icons.length} syndicate icons` : `${savedCards} of ${cards.length} card images`;
			const other = !missingIcons ? `${missingCards}` : !missingCards ? `${missingIcons} icons` : `${missingCards} cards and ${missingIcons} icons`;
			return `${saved} are saved. Download the other ${other} now, so every card also shows offline. They are shrunk to ${CACHED_IMAGE_WIDTH}px like the others.`;
		};
		const show = (p: DownloadProgress | null) => {
			if (p?.running) {
				setting.setDesc(`Downloading… ${p.done}/${p.total}${p.failed ? ` (${p.failed} failed)` : ""}`);
				downloadBtn.setButtonText("Cancel").removeCta().setDisabled(false);
				return;
			}
			void Promise.all([imageCache.savedCount(images.cards), imageCache.savedCount(images.icons)]).then(([savedCards, savedIcons]) => {
				const missing = images.cards.length + images.icons.length - savedCards - savedIcons;
				setting.setDesc(describe(savedCards, savedIcons));
				downloadBtn.setButtonText("Download").setCta().setDisabled(!s.cacheImages || missing === 0);
			});
		};
		const stopListening = imageCache.onDownloadProgress(show);
		const stopRefreshing = this.keepFresh(() => {
			// Each image style has its own images.
			images = imagesToSave(this.plugin.cards.all(), s);
			show(imageCache.downloadProgress);
		});
		return () => {
			stopListening();
			stopRefreshing();
		};
	}

	private renderClearImages(setting: Setting): () => void {
		const showStats = () =>
			void imageCache.stats().then(({ files, bytes }) => {
				setting.setDesc(`${files} image(s), ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
			});
		setting.addButton((b) =>
			b.setButtonText("Clear").onClick(async () => {
				b.setDisabled(true);
				try {
					await imageCache.clear();
					this.refreshers.forEach((refresh) => refresh());
				} finally {
					b.setDisabled(false);
				}
			}),
		);
		const stopListening = imageCache.onDownloadProgress((p) => {
			if (!p.running) showStats();
		});
		const stopRefreshing = this.keepFresh(showStats);
		return () => {
			stopListening();
			stopRefreshing();
		};
	}

	private async stopSavingImages(): Promise<void> {
		this.plugin.settings.cacheImages = false;
		await this.plugin.saveSettings();
		imageCache.cancelDownload();
		await imageCache.clear();
		this.refreshers.forEach((refresh) => refresh());
	}

	private async confirmDownloadAll(images: { cards: string[]; icons: string[] }): Promise<void> {
		const missingCards = images.cards.length - (await imageCache.savedCount(images.cards));
		const missingIcons = images.icons.length - (await imageCache.savedCount(images.icons));
		if (!missingCards && !missingIcons) return;
		// The icons are about 3 KB each: only the card images count for the size.
		const mb = (kb: number) => Math.max(1, Math.round((missingCards * kb) / 1024));
		const icons = `${missingIcons} syndicate icon${missingIcons === 1 ? "" : "s"}`;
		new ConfirmModal(this.app, {
			title: "Download all card images",
			message: !missingCards
				? `This downloads ${icons}. You can keep using Obsidian while it runs.`
				: `This downloads ${missingCards} card images${missingIcons ? ` and ${icons}` : ""} (about ${mb(ORIGINAL_IMAGE_KB)} MB) and keeps a ${CACHED_IMAGE_WIDTH}px copy of each ` +
					`(about ${mb(CACHED_IMAGE_KB)} MB in the plugin folder). You can keep using Obsidian while it runs.`,
			cta: "Download",
			onConfirm: () => void this.plugin.downloadAllCardImages(),
		}).open();
	}
}

/** Same clean-up the old text inputs did: trimmed URL, folders without a trailing slash, a valid interval. */
function normalizeControlValue(key: ControlKey, value: unknown): unknown {
	switch (key) {
		case "customDataUrl":
			return typeof value === "string" ? value.trim() : "";
		case "matchLog":
			return typeof value === "string" ? value.trim() : "";
		case "notesFolder":
		case "templateFolder":
			return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
		case "autoRefreshDays": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.autoRefreshDays;
		}
		default:
			return value;
	}
}
