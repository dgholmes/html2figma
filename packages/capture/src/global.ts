import { capturePage } from './index';

declare global { interface Window { __h2fCapture?: { capturePage: typeof capturePage } } }
window.__h2fCapture = { capturePage };
