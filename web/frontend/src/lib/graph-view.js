const svgNS = 'http://www.w3.org/2000/svg';
const nodeRadius = 14;
const syncLayoutLimit = 400;

function seededPosition(id, index, width, height, count) {
    let seed = Math.imul(Number(id) || index + 1, 2654435761) >>> 0;
    seed = (seed ^ (seed >>> 16)) >>> 0;
    const angle = (seed / 0x100000000) * Math.PI * 2;
    const radius = Math.min(width, height) * 0.1 + Math.sqrt(index / Math.max(1, count)) * Math.min(width, height) * 0.29;
    return {
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius
    };
}

export function layoutGraph(nodes, edges, width, height) {
    const bounds = { width: Math.max(320, width), height: Math.max(280, height) };
    const positioned = nodes.map((node, index) => ({
        ...node,
        x: seededPosition(node.id, index, bounds.width, bounds.height, nodes.length).x,
        y: seededPosition(node.id, index, bounds.width, bounds.height, nodes.length).y,
        degree: 0
    }));
    const byID = new Map(positioned.map((node, index) => [Number(node.id), index]));
    const validEdges = edges.filter(edge => byID.has(Number(edge.source)) && byID.has(Number(edge.target)));
    for (const edge of validEdges) {
        const source = byID.get(Number(edge.source));
        const target = byID.get(Number(edge.target));
        positioned[source].degree++;
        positioned[target].degree++;
    }

    const cellSize = 120;
    const iterations = positioned.length > 1200 ? 24 : 64;
    for (let iteration = 0; iteration < iterations; iteration++) {
        const cells = new Map();
        for (let index = 0; index < positioned.length; index++) {
            const node = positioned[index];
            const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(index);
        }
        const forces = positioned.map(() => ({ x: 0, y: 0 }));
        for (let index = 0; index < positioned.length; index++) {
            const node = positioned[index];
            const cellX = Math.floor(node.x / cellSize);
            const cellY = Math.floor(node.y / cellSize);
            for (let x = cellX - 1; x <= cellX + 1; x++) {
                for (let y = cellY - 1; y <= cellY + 1; y++) {
                    for (const otherIndex of cells.get(`${x},${y}`) || []) {
                        if (otherIndex === index) continue;
                        const other = positioned[otherIndex];
                        let dx = node.x - other.x;
                        let dy = node.y - other.y;
                        let distanceSquared = dx * dx + dy * dy;
                        if (distanceSquared < 1) {
                            dx = (index < otherIndex ? -1 : 1) * 0.5;
                            dy = (index % 2 ? -1 : 1) * 0.5;
                            distanceSquared = 0.5;
                        }
                        if (distanceSquared > cellSize * cellSize * 2) continue;
                        const distance = Math.sqrt(distanceSquared);
                        const strength = Math.min(7, 850 / distanceSquared);
                        forces[index].x += dx / distance * strength;
                        forces[index].y += dy / distance * strength;
                    }
                }
            }
        }
        for (const edge of validEdges) {
            const sourceIndex = byID.get(Number(edge.source));
            const targetIndex = byID.get(Number(edge.target));
            const source = positioned[sourceIndex];
            const target = positioned[targetIndex];
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const distance = Math.max(1, Math.hypot(dx, dy));
            const strength = Math.min(5, (distance - 125) * 0.006);
            const fx = dx / distance * strength;
            const fy = dy / distance * strength;
            forces[sourceIndex].x += fx;
            forces[sourceIndex].y += fy;
            forces[targetIndex].x -= fx;
            forces[targetIndex].y -= fy;
        }
        const cooling = 1 - iteration / (iterations * 1.15);
        for (let index = 0; index < positioned.length; index++) {
            const node = positioned[index];
            node.x = Math.min(bounds.width - 80, Math.max(80, node.x + forces[index].x * cooling + (bounds.width / 2 - node.x) * 0.002));
            node.y = Math.min(bounds.height - 60, Math.max(60, node.y + forces[index].y * cooling + (bounds.height / 2 - node.y) * 0.002));
        }
    }
    return { nodes: positioned, edges: validEdges, width: bounds.width, height: bounds.height };
}

function svgElement(name, attributes = {}) {
    const element = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
}

export class GraphView {
    constructor(svg, onOpenNote) {
        this.svg = svg;
        this.onOpenNote = onOpenNote;
        this.graph = { nodes: [], edges: [] };
        this.layout = null;
        this.search = '';
        this.transform = { x: 0, y: 0, scale: 1 };
        this.drag = null;
        this.hoveredNodeID = null;
        this.ignoreNextClick = false;
        this.hasRendered = false;
        this.viewport = null;
        this.nodeElements = new Map();
        this.nodeById = new Map();
        this.edgeRecords = [];
        this.edgesByNode = new Map();
        this.worker = null;
        this.workerFailed = false;
        this.layoutRequestID = 0;
        this.fitAfterLayout = false;
        this.resizeTimer = 0;
        this.handleWindowResize = () => {
            window.clearTimeout(this.resizeTimer);
            this.resizeTimer = window.setTimeout(() => {
                this.resizeTimer = 0;
                this.resize();
            }, 120);
        };
        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(this.handleWindowResize);
            this.resizeObserver.observe(svg);
        } else {
            this.resizeObserver = null;
            window.addEventListener('resize', this.handleWindowResize);
        }
        svg.addEventListener('wheel', event => this.handleWheel(event), { passive: false });
        svg.addEventListener('pointerdown', event => this.startPan(event));
        svg.addEventListener('pointermove', event => this.movePointer(event));
        svg.addEventListener('pointerup', event => this.endPointer(event));
        svg.addEventListener('pointercancel', event => this.endPointer(event));
        svg.addEventListener('pointerover', event => {
            const group = event.target.closest('[data-node-id]');
            this.hoveredNodeID = group ? Number(group.dataset.nodeId) : null;
            this.applyHighlights();
        });
        svg.addEventListener('pointerout', event => {
            const group = event.target.closest('[data-node-id]');
            if (group && !group.contains(event.relatedTarget)) {
                this.hoveredNodeID = null;
                this.applyHighlights();
            }
        });
        svg.addEventListener('click', event => {
            if (this.ignoreNextClick) {
                this.ignoreNextClick = false;
                event.preventDefault();
                return;
            }
            const group = event.target.closest('[data-node-id]');
            if (group && !this.drag?.moved) this.onOpenNote(Number(group.dataset.nodeId));
        });
        svg.addEventListener('keydown', event => {
            const group = event.target.closest('[data-node-id]');
            if (group && ['Enter', ' '].includes(event.key)) {
                event.preventDefault();
                this.onOpenNote(Number(group.dataset.nodeId));
            }
        });
    }

    setGraph(graph) {
        this.graph = graph;
        this.transform = { x: 0, y: 0, scale: 1 };
        this.layout = null;
        this.render();
    }

    setSearch(search) {
        this.search = search.trim().toLocaleLowerCase();
        // The structure does not change while filtering; only classes do.
        this.applyHighlights();
    }

    resize() {
        const bounds = this.svg.getBoundingClientRect();
        if (bounds.width < 1 || bounds.height < 1) return;
        this.layout = null;
        this.transform = { x: 0, y: 0, scale: 1 };
        this.render();
    }

    fit() {
        if (!this.layout || this.layout.nodes.length === 0) {
            this.fitAfterLayout = true;
            return;
        }
        const xs = this.layout.nodes.map(node => node.x);
        const ys = this.layout.nodes.map(node => node.y);
        const minX = Math.min(...xs) - 100;
        const maxX = Math.max(...xs) + 100;
        const minY = Math.min(...ys) - 90;
        const maxY = Math.max(...ys) + 90;
        const width = this.layout.width;
        const height = this.layout.height;
        const scale = Math.min(width / (maxX - minX), height / (maxY - minY), 1.4);
        this.transform = {
            x: width / 2 - ((minX + maxX) / 2) * scale,
            y: height / 2 - ((minY + maxY) / 2) * scale,
            scale
        };
        this.applyTransform();
    }

    render() {
        const bounds = this.svg.getBoundingClientRect();
        if (bounds.width < 1 || bounds.height < 1) return;
        const needsLayout = !this.layout ||
            this.layout.nodes.length !== this.graph.nodes.length ||
            this.layout.width !== bounds.width ||
            this.layout.height !== bounds.height;
        if (needsLayout) {
            if (!this.requestLayout(bounds.width, bounds.height)) return;
        } else if (!this.viewport) {
            this.buildStructure();
        }
        this.applyTransform();
        this.applyHighlights();
    }

    // Small graphs are faster to lay out synchronously. Larger ones go to a
    // worker so panning the rest of the UI stays responsive.
    requestLayout(width, height) {
        if (this.graph.nodes.length <= syncLayoutLimit || this.workerFailed || typeof Worker !== 'function') {
            this.layout = layoutGraph(this.graph.nodes, this.graph.edges, width, height);
            this.buildStructure();
            this.applyPendingFit();
            return true;
        }
        const requestID = ++this.layoutRequestID;
        if (!this.worker) this.worker = this.createLayoutWorker();
        if (!this.worker) {
            this.workerFailed = true;
            return this.requestLayout(width, height);
        }
        this.showLayoutPending(width, height);
        this.worker.postMessage({
            id: requestID,
            nodes: this.graph.nodes,
            edges: this.graph.edges,
            width,
            height
        });
        return false;
    }

    createLayoutWorker() {
        try {
            const worker = new Worker(new URL('./graph-layout-worker.js', import.meta.url), { type: 'module' });
            worker.addEventListener('message', event => this.receiveLayout(event.data));
            worker.addEventListener('error', () => {
                this.worker?.terminate();
                this.worker = null;
                this.workerFailed = true;
                const bounds = this.svg.getBoundingClientRect();
                if (bounds.width < 1 || bounds.height < 1) return;
                this.layout = layoutGraph(this.graph.nodes, this.graph.edges, bounds.width, bounds.height);
                this.buildStructure();
                this.applyTransform();
                this.applyHighlights();
                this.applyPendingFit();
            });
            return worker;
        } catch {
            return null;
        }
    }

    receiveLayout(data) {
        if (!data || data.id !== this.layoutRequestID) return;
        const bounds = this.svg.getBoundingClientRect();
        if (bounds.width < 1 || bounds.height < 1) return;
        // The viewport changed while the worker was busy; request fresh
        // dimensions instead of installing a stale layout.
        if (Math.abs(data.layout.width - bounds.width) > 1 ||
            Math.abs(data.layout.height - bounds.height) > 1) {
            this.layout = null;
            this.render();
            return;
        }
        this.layout = data.layout;
        this.buildStructure();
        this.applyTransform();
        this.applyHighlights();
        this.applyPendingFit();
    }

    applyPendingFit() {
        if (!this.fitAfterLayout) return;
        this.fitAfterLayout = false;
        this.fit();
    }

    showLayoutPending(width, height) {
        if (this.viewport) return;
        const label = svgElement('text', {
            x: width / 2,
            y: height / 2,
            'text-anchor': 'middle',
            class: 'graph-loading'
        });
        label.textContent = 'Calculando layout…';
        this.svg.replaceChildren(label);
    }

    buildStructure() {
        const { width, height, nodes, edges } = this.layout;
        this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const defs = svgElement('defs');
        const marker = svgElement('marker', {
            id: 'graph-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
            markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse'
        });
        marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'graph-arrowhead' }));
        defs.append(marker);
        const viewport = svgElement('g');
        const edgesGroup = svgElement('g', { class: 'graph-edges' });
        const nodesGroup = svgElement('g', { class: 'graph-nodes' });

        this.nodeElements = new Map();
        this.nodeById = new Map();
        this.edgeRecords = [];
        this.edgesByNode = new Map();
        for (const node of nodes) {
            const id = Number(node.id);
            node.searchText = `${node.title} ${node.folder}`.toLocaleLowerCase();
            this.nodeById.set(id, node);
        }

        for (const edge of edges) {
            const sourceID = Number(edge.source);
            const targetID = Number(edge.target);
            if (!this.nodeById.has(sourceID) || !this.nodeById.has(targetID)) continue;
            const element = svgElement('line', {
                class: `graph-edge${edge.type === 'wikilink' ? ' is-wikilink' : ''}`,
                'data-source': edge.source, 'data-target': edge.target,
                'marker-end': 'url(#graph-arrow)'
            });
            const record = { element, sourceID, targetID };
            this.edgeRecords.push(record);
            if (!this.edgesByNode.has(sourceID)) this.edgesByNode.set(sourceID, []);
            if (!this.edgesByNode.has(targetID)) this.edgesByNode.set(targetID, []);
            this.edgesByNode.get(sourceID).push(record);
            this.edgesByNode.get(targetID).push(record);
            this.positionEdge(record);
            edgesGroup.append(element);
        }

        for (const node of nodes) {
            const group = svgElement('g', {
                class: 'graph-node',
                transform: `translate(${node.x} ${node.y})`,
                tabindex: 0,
                role: 'button',
                'aria-label': `Abrir nota ${node.title}`,
                'data-node-id': node.id
            });
            const label = node.title.length > 23 ? `${node.title.slice(0, 22)}…` : node.title;
            const circle = svgElement('circle', {
                cx: 0, cy: 0, r: nodeRadius,
                class: 'graph-node-shape'
            });
            const text = svgElement('text', { x: 0, y: nodeRadius + 16, class: 'graph-node-label' });
            text.textContent = label;
            const title = svgElement('title');
            title.textContent = `${node.title}${node.folder ? ` · ${node.folder}` : ''} (${node.degree} conexões)`;
            group.append(circle, text, title);
            nodesGroup.append(group);
            this.nodeElements.set(Number(node.id), group);
        }

        viewport.append(edgesGroup, nodesGroup);
        this.svg.replaceChildren(defs, viewport);
        this.viewport = viewport;
        this.hasRendered = true;
    }

    positionEdge(record) {
        const source = this.nodeById.get(record.sourceID);
        const target = this.nodeById.get(record.targetID);
        if (!source || !target) return;
        const distance = Math.hypot(target.x - source.x, target.y - source.y) || 1;
        const unitX = (target.x - source.x) / distance;
        const unitY = (target.y - source.y) / distance;
        record.element.setAttribute('x1', String(source.x + unitX * nodeRadius));
        record.element.setAttribute('y1', String(source.y + unitY * nodeRadius));
        record.element.setAttribute('x2', String(target.x - unitX * nodeRadius));
        record.element.setAttribute('y2', String(target.y - unitY * nodeRadius));
    }

    positionNode(nodeID) {
        const node = this.nodeById.get(nodeID);
        const element = this.nodeElements.get(nodeID);
        if (node && element) element.setAttribute('transform', `translate(${node.x} ${node.y})`);
        for (const record of this.edgesByNode.get(nodeID) || []) this.positionEdge(record);
    }

    applyTransform() {
        if (!this.viewport) return;
        this.viewport.setAttribute('transform',
            `translate(${this.transform.x} ${this.transform.y}) scale(${this.transform.scale})`);
    }

    applyHighlights() {
        if (!this.layout) return;
        const selectedID = this.hoveredNodeID;
        const neighbors = new Set();
        if (selectedID !== null) {
            for (const record of this.edgesByNode.get(selectedID) || []) {
                neighbors.add(record.sourceID === selectedID ? record.targetID : record.sourceID);
            }
        }
        const query = this.search;
        for (const node of this.layout.nodes) {
            const id = Number(node.id);
            const element = this.nodeElements.get(id);
            if (!element) continue;
            const matches = !query || node.searchText.includes(query);
            const emphasized = selectedID === id || neighbors.has(id);
            element.classList.toggle('is-selected', selectedID === id);
            element.classList.toggle('is-neighbor', selectedID !== null && neighbors.has(id));
            element.classList.toggle('is-dimmed', !matches || (selectedID !== null && !emphasized));
        }
        for (const record of this.edgeRecords) {
            const source = this.nodeById.get(record.sourceID);
            const target = this.nodeById.get(record.targetID);
            const matches = !query ||
                `${source?.searchText || ''} ${target?.searchText || ''}`.includes(query);
            const connected = selectedID === null ||
                record.sourceID === selectedID || record.targetID === selectedID;
            record.element.classList.toggle('is-dimmed', !matches || !connected);
            record.element.classList.toggle('is-highlighted', connected && selectedID !== null);
        }
    }

    pointerPosition(event) {
        const point = this.svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const local = point.matrixTransform(this.svg.getScreenCTM().inverse());
        return {
            x: (local.x - this.transform.x) / this.transform.scale,
            y: (local.y - this.transform.y) / this.transform.scale
        };
    }

    startPan(event) {
        if (event.button !== 0) return;
        const nodeElement = event.target.closest('[data-node-id]');
        if (nodeElement) {
            const nodeID = Number(nodeElement.dataset.nodeId);
            const node = this.nodeById.get(nodeID);
            if (!node) return;
            const point = this.pointerPosition(event);
            this.drag = {
                kind: 'node',
                nodeID,
                startX: point.x,
                startY: point.y,
                offsetX: point.x - node.x,
                offsetY: point.y - node.y,
                moved: false
            };
            this.svg.setPointerCapture(event.pointerId);
            return;
        }
        this.drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, x: this.transform.x, y: this.transform.y, moved: false };
        this.svg.setPointerCapture(event.pointerId);
    }

    movePointer(event) {
        if (!this.drag) return;
        if (this.drag.kind === 'pan') {
            const dx = event.clientX - this.drag.startX;
            const dy = event.clientY - this.drag.startY;
            this.drag.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
            this.transform.x = this.drag.x + dx;
            this.transform.y = this.drag.y + dy;
            this.applyTransform();
            return;
        }
        const node = this.nodeById.get(this.drag.nodeID);
        if (!node) return;
        const point = this.pointerPosition(event);
        this.drag.moved ||= Math.abs(point.x - this.drag.startX) + Math.abs(point.y - this.drag.startY) > 3;
        node.x = point.x - this.drag.offsetX;
        node.y = point.y - this.drag.offsetY;
        this.positionNode(this.drag.nodeID);
    }

    endPointer(event) {
        if (!this.drag) return;
        const drag = this.drag;
        const moved = drag.moved;
        this.drag = null;
        if (moved) {
            this.ignoreNextClick = true;
            event.preventDefault();
            this.applyTransform();
            return;
        }
        // Pointer capture retargets the following click event to the <svg>, so a
        // node click has to be resolved here instead of in the click handler.
        if (event.type === 'pointerup' && drag.kind === 'node') {
            this.ignoreNextClick = true;
            this.onOpenNote(drag.nodeID);
        }
    }

    handleWheel(event) {
        event.preventDefault();
        const bounds = this.svg.getBoundingClientRect();
        const cursorX = event.clientX - bounds.left;
        const cursorY = event.clientY - bounds.top;
        const oldScale = this.transform.scale;
        const scale = Math.min(3, Math.max(0.35, oldScale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
        const ratio = scale / oldScale;
        this.transform.x = cursorX - (cursorX - this.transform.x) * ratio;
        this.transform.y = cursorY - (cursorY - this.transform.y) * ratio;
        this.transform.scale = scale;
        this.applyTransform();
    }

    destroy() {
        window.clearTimeout(this.resizeTimer);
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        if (this.resizeObserver) this.resizeObserver.disconnect();
        else window.removeEventListener('resize', this.handleWindowResize);
    }
}
