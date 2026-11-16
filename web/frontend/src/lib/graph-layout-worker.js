import { layoutGraph } from './graph-view.js';

// Layout runs off the main thread for large graphs. For small graphs the
// caller keeps the synchronous path, which avoids worker startup latency.
self.onmessage = event => {
    const { id, nodes, edges, width, height } = event.data;
    const layout = layoutGraph(nodes, edges, width, height);
    self.postMessage({ id, layout });
};
