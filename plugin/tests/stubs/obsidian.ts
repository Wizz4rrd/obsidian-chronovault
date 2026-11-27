// Stand-in for the parts of the "obsidian" module the tested code imports (see scripts/test.mjs).
export type TAbstractFile = { path: string };

export function normalizePath(path: string): string {
	return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

/** Every URL requested, and the response to give. */
export const requests: string[] = [];
export const response = { status: 200, contentType: "image/png" };

export async function requestUrl(options: { url: string }) {
	requests.push(options.url);
	return { status: response.status, headers: { "content-type": response.contentType }, arrayBuffer: new ArrayBuffer(8) };
}
