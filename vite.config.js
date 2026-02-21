import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
export default defineConfig({
    base: '/FastShaders/',
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    define: {
        'process.env': { NODE_ENV: JSON.stringify('production') },
    },
    server: {
        port: 5173,
        open: true,
    },
    build: {
        target: 'esnext',
    },
});
