import { test } from "node:test";
import assert from "node:assert/strict";
import { fillTemplate } from "../src/templates/fillTemplate";

/** Stand-in for moment: "date" formats give the note's date, "time" ones the time now. */
const format = (pattern: string, which: "date" | "time") => `${which}<${pattern}>`;

test("templates: the plugin's placeholders and Obsidian's core ones", () => {
	const values = { name: "2026-11-16 Chrono Cup", date: "2026-11-16", event: "Chrono Cup" };
	assert.equal(fillTemplate("# {{name}} / {{title}}", values, format), "# 2026-11-16 Chrono Cup / 2026-11-16 Chrono Cup");
	assert.equal(fillTemplate("{{date}} {{date:dddd D MMMM}} {{ date:YYYY }}", values, format), "2026-11-16 date<dddd D MMMM> date<YYYY>");
	assert.equal(fillTemplate("{{time}} {{time:HH:mm:ss}}", values, format), "time<HH:mm> time<HH:mm:ss>");
	// Unknown ones (e.g. Templater's) and formats on other placeholders are left alone.
	assert.equal(fillTemplate("{{unknown}} {{event:x}} {{event}}", values, format), "{{unknown}} {{event:x}} Chrono Cup");
});
