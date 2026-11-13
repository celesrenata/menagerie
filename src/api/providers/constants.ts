import { Package } from "../../shared/package"

export const DEFAULT_HEADERS = {
	"HTTP-Referer": "https://github.com/celesrenata/menagerie",
	"X-Title": "Menagerie",
	"User-Agent": `Menagerie/${Package.version}`,
}

export const NOT_PROVIDED = "not-provided"
