import { test } from "node:test";
import assert from "node:assert/strict";
import { requests } from "obsidian";
import { ImageCache } from "../src/utils/ImageCache";

const DIR = "Z_attachments/ChronoVault";
const url = (id: number) => `https://cdn.playchrono.com/latest/en_us/img/cards/full/set_1/${id}.png`;
const file = (id: number, ext: string) => `${DIR}/cdn.playchrono.com_latest_en_us_img_cards_full_set_1_${id}-w400.${ext}`;

type Listener = (file: { path: string }, oldPath?: string) => void;

/** A device: its disk (shared with the others through sync) and Obsidian's vault events. */
function device(disk: Map<string, ArrayBuffer>, ext: "webp" | "png") {
	const listeners = new Map<string, Listener[]>();
	const emit = (event: string, path: string, oldPath?: string) => listeners.get(event)?.forEach((l) => l({ path }, oldPath));
	const adapter = {
		exists: async (p: string) => p === DIR || disk.has(p),
		list: async (p: string) => ({ files: [...disk.keys()].filter((f) => f.startsWith(`${p}/`)), folders: [] }),
		mkdir: async () => {},
		readBinary: async (p: string) => disk.get(p) ?? new ArrayBuffer(0),
		writeBinary: async (p: string, data: ArrayBuffer) => void disk.set(p, data),
		remove: async (p: string) => void disk.delete(p),
		rmdir: async () => {},
		rename: async () => {},
		getResourcePath: (p: string) => `app://local/${p}`,
	};
	const plugin = {
		settings: { cacheImages: true, imageFolder: "vault", imageCacheDir: DIR, notesFolder: "", dataSource: "official" },
		manifest: { id: "chronovault", dir: ".obsidian/plugins/chronovault" },
		app: {
			vault: {
				adapter,
				configDir: ".obsidian",
				getConfig: () => "Z_attachments",
				on: (event: string, listener: Listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
			},
		},
		registerEvent: () => {},
		saveSettings: async () => {},
	};
	const cache = new ImageCache();
	// No canvas in node: the format this device encodes, and a shrink that keeps the bytes.
	Object.assign(cache, { encoding: { type: `image/${ext}`, ext }, shrink: async (data: ArrayBuffer) => data });
	cache.init(plugin as never);
	/** Another device's file arrives through sync. */
	const synced = (path: string) => {
		disk.set(path, new ArrayBuffer(8));
		emit("create", path);
	};
	/** Another device's deletion arrives through sync. */
	const unsynced = (path: string) => {
		disk.delete(path);
		emit("delete", path);
	};
	return { cache, synced, unsynced, disk };
}

/** The window the images are shown in: the cache finds them there to reload them. */
const shownImages: HTMLImageElement[] = [];
const win = { document: { querySelectorAll: () => shownImages }, addEventListener() {} };

function img() {
	const el = { src: "", win, addClass() {}, removeClass() {}, getAttribute: () => el.src };
	shownImages.push(el as unknown as HTMLImageElement);
	return el as unknown as HTMLImageElement;
}

/** Show the card `id` and wait until its image is loaded. */
async function show(cache: ImageCache, id: number): Promise<string> {
	const el = img();
	cache.setSrc(el, url(id));
	for (let i = 0; i < 20 && (!el.src || el.src === url(id)); i++) await new Promise((r) => setTimeout(r, 1));
	return el.src;
}

test("iPad uses a WebP that synced in while Obsidian stayed open", async () => {
	requests.length = 0;
	const ipad = device(new Map([[file(1, "webp"), new ArrayBuffer(8)]]), "png");
	await ipad.cache.savedCount([]);
	ipad.synced(file(14, "webp"));
	assert.equal(await show(ipad.cache, 14), `app://local/${file(14, "webp")}`);
	assert.deepEqual(requests, []);
	assert.ok(!ipad.disk.has(file(14, "png")));
});

test("a WebP the index missed is found on disk instead of downloaded", async () => {
	requests.length = 0;
	const disk = new Map<string, ArrayBuffer>();
	const ipad = device(disk, "png");
	await ipad.cache.savedCount([]);
	// No vault event: e.g. the "plugin folder" setting, outside the vault index.
	disk.set(file(14, "webp"), new ArrayBuffer(8));
	assert.equal(await show(ipad.cache, 14), `app://local/${file(14, "webp")}`);
	assert.deepEqual(requests, []);
	assert.equal(await ipad.cache.savedCount([url(14)]), 1);
});

test("an image whose file another device deleted switches to the other format", async () => {
	requests.length = 0;
	const ipad = device(new Map([[file(5, "png"), new ArrayBuffer(8)]]), "png");
	await ipad.cache.savedCount([]);
	const el = img();
	ipad.cache.setSrc(el, url(5));
	assert.equal(el.src, `app://local/${file(5, "png")}`);
	// Desktop converted the iPad's PNG to WebP.
	ipad.synced(file(5, "webp"));
	ipad.unsynced(file(5, "png"));
	assert.equal(el.src, `app://local/${file(5, "webp")}`);
	assert.deepEqual(requests, []);
});

test("an image missing in every format is still downloaded, once", async () => {
	requests.length = 0;
	const ipad = device(new Map(), "png");
	await ipad.cache.savedCount([]);
	const [a, b] = await Promise.all([show(ipad.cache, 7), show(ipad.cache, 7)]);
	assert.equal(a, `app://local/${file(7, "png")}`);
	assert.equal(b, a);
	assert.deepEqual(requests, [url(7)]);
	assert.ok(ipad.disk.has(file(7, "png")));
});

test("desktop keeps the WebP when both formats are saved, and converts lone PNGs", async () => {
	const disk = new Map([
		[file(1, "webp"), new ArrayBuffer(8)],
		[file(1, "png"), new ArrayBuffer(8)],
		[file(2, "png"), new ArrayBuffer(8)],
	]);
	const desktop = device(disk, "webp");
	await desktop.cache.savedCount([]);
	for (let i = 0; i < 20 && disk.has(file(2, "png")); i++) await new Promise((r) => setTimeout(r, 1));
	assert.deepEqual([...disk.keys()].sort(), [file(1, "webp"), file(2, "webp")]);
});
