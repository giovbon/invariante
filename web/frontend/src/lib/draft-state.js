// Pure helpers shared by the editor and the autosave flow. Keeping them free
// of DOM access makes the dirty-check rules testable and prevents the checks
// from drifting between the editor and the table view.

export function draftsEqual(left, right) {
    if (!left || !right) return left === right;
    return left.title === right.title &&
        left.folder === right.folder &&
        left.content === right.content;
}

export function tagListsEqual(left, right) {
    const first = Array.isArray(left) ? left : [];
    const second = Array.isArray(right) ? right : [];
    if (first.length !== second.length) return false;
    return first.every((tag, index) => tag === second[index]);
}

// The frontmatter property that removes a note from the explorer is stored in
// the note body, so a content save can change the folder tree even when the
// title and folder stay the same.
export function hidesFromExplorer(content) {
    if (!content || !content.includes('hide_from_explorer')) return false;
    return /(^|\n)\s*hide_from_explorer\s*:\s*["']?(true|yes|on)["']?\s*(#.*)?(\n|$)/i.test(content);
}
