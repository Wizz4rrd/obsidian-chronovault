/**
 * Fill a note template's placeholders: the plugin's own (`{{name}}`, `{{deck}}`…,
 * from `values`) and those of Obsidian's core Templates plugin, so one note can
 * serve as both:
 *
 * - `{{title}}`: the note's name (like `{{name}}`)
 * - `{{date}}`: the note's date, YYYY-MM-DD (a tournament's date, else today)
 * - `{{date:FORMAT}}`: the note's date in a moment.js format, e.g. `{{date:dddd D MMMM}}`
 * - `{{time}}` / `{{time:FORMAT}}`: the time now (HH:mm by default)
 *
 * Unknown placeholders are left as they are, e.g. for Templater.
 */
export function fillTemplate(template: string, values: Record<string, string>, format: (pattern: string, which: "date" | "time") => string): string {
	return template.replace(/\{\{\s*(\w+)(?::([^}\n]+?))?\s*\}\}/g, (m, key: string, pattern?: string) => {
		if (key === "date" && pattern) return format(pattern.trim(), "date");
		if (key === "time") return format(pattern?.trim() || "HH:mm", "time");
		if (pattern) return m;
		if (key === "title" && !("title" in values)) return values.name ?? m;
		return key in values ? values[key] : m;
	});
}
