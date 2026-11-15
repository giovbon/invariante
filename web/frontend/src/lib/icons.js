// Single source of truth for the outline icons reused across the explorer,
// the Tabulator view and the search cards. Keeping the path data here avoids
// the same concept drifting into slightly different drawings.
const iconDefinitions = {
    note: [
        ['page', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'],
        ['fold', 'M14 2v6h6'],
        ['lines', 'M16 13H8m8 4H8m5-8H8']
    ],
    file: [
        ['page', 'M6 3h8l4 4v14H6z'],
        ['fold', 'M14 3v5h5']
    ],
    pdf: [
        ['page', 'M6 3h8l4 4v14H6z'],
        ['fold', 'M14 3v5h5'],
        ['lines', 'M9 14h6M9 17h4']
    ],
    folder: [
        ['body', 'M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
        ['tab', 'M3.5 8.5v-2a2 2 0 0 1 2-2h3l2 2']
    ]
};

export function iconPaths(name) {
    return iconDefinitions[name] || iconDefinitions.note;
}

export function iconHTML(name) {
    const paths = iconPaths(name)
        .map(([, path]) => `<path d="${path}"/>`)
        .join('');
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

export function iconElement(name, className = '', pathClassPrefix = '') {
    const namespace = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(namespace, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    if (className) icon.classList.add(className);
    for (const [part, pathData] of iconPaths(name)) {
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', pathData);
        if (pathClassPrefix) path.classList.add(`${pathClassPrefix}-${part}`);
        icon.append(path);
    }
    return icon;
}
