import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('The React mount is missing.');
createRoot(root).render(<App />);
