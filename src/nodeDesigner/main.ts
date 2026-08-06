/**
 * Entry point for node-designer.html — the Node Designer, now a Vite entry in
 * the app's module graph so its stage renders the REAL node renderer
 * (NodeVisual) instead of a hand-written mimic.
 *
 * CORE SAFETY INVARIANT (same as nodeEditor.tsx): `../nodeEditorBootstrap`
 * MUST stay the first import. This page shares its origin with the real
 * editor and mounts the same zustand store (NodeVisual's DragNumberInput
 * brackets history via store actions; ndData reads cost-colour prefs), and
 * the store autosaves `fs:graph` from a module-scope subscribe — one
 * incidental action against this page's empty store would overwrite the
 * user's real graph. The bootstrap disables that autosave before ANY store
 * code can run; import order is the only ordering guarantee that holds.
 */
import '../nodeEditorBootstrap';

// The app's real font + token + component styles — the designer preview must
// render with the SAME faces and metrics as the editor (the old standalone
// page silently fell back to system fonts, one more way it was "not precise").
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../styles/tokens.css';
// React Flow's base stylesheet defines .react-flow__handle — the socket
// geometry the static replica reuses. No ReactFlow instance mounts here.
import '@xyflow/react/dist/style.css';

// The designer app itself (ported inline script). Its imports pull in the
// bridge → NodeVisual → ShaderNode.css/NodeBase.css/TypedHandle.css, so the
// stage styles are literally the app's.
import './designerApp';
