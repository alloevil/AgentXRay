// Demo-mode flag (GitHub Pages build). Set VITE_DEMO=1 at build time to serve
// the UI from bundled synthetic fixtures instead of the local backend.
// Kept in its own module so importing the flag never pulls in the fixtures.
export const DEMO = import.meta.env.VITE_DEMO === '1';
