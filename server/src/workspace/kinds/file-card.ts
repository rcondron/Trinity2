/*
 * A file from the file store (services/files.ts) as a "file" card's data: its description for display, and the first
 * lines of a text file. The board draws it (kinds/render.ts); Open and Download go through the window, which builds
 * the file's address itself from the id and the name (web/src/workspace/view.ts).
 */
import { describeFile, FILE_KINDS, readText, type StoredFile } from "../../services/files.js";
import type { FileCardData } from "./data.js";

/** The card data for a stored file (not yet normalized: addCard does that). */
export function fileCardData(file: StoredFile): FileCardData {
  const info = describeFile(file);
  let preview: string | undefined;
  if (FILE_KINDS[file.kind].text) {
    try {
      preview = readText(file.id, 1200).text;
    } catch {
      preview = undefined; // unreadable now: the card shows the file without it
    }
  }
  return {
    id: info.id,
    name: info.name,
    ext: FILE_KINDS[file.kind].ext,
    mime: info.mime,
    type: info.type.charAt(0).toUpperCase() + info.type.slice(1),
    size: info.size,
    opens: info.opens,
    ...(info.description ? { description: info.description } : {}),
    ...(preview ? { preview } : {}),
  };
}
