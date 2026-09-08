import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@react-pdf/renderer', 'pdf-parse', 'pdfjs-dist', '@napi-rs/canvas', 'tesseract.js', 'tesseract.js-core'],
  // pdfjs-dist carrega @napi-rs/canvas e o pdf.worker.mjs via require()/import() dinâmico
  // (process.getBuiltinModule('module').createRequire / import.meta.url), padrão que o
  // rastreador de arquivos da Vercel (@vercel/nft) não detecta — precisa incluir manualmente.
  outputFileTracingIncludes: {
    '/api/etiquetas/upload': [
      './node_modules/@napi-rs/canvas/**/*',
      './node_modules/@napi-rs/canvas-linux-x64-gnu/**/*',
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
    // tesseract.js spawna um worker_threads via caminho de arquivo (workerPath), fora
    // do grafo estático que o rastreador de arquivos da Vercel (@vercel/nft) segue — o
    // require('..') relativo dentro do próprio worker script (pra src/worker-script/,
    // src/worker-script/node/getCore.js -> tesseract.js-core/*) nunca era incluído no
    // bundle serverless, derrubando a function com "Cannot find module '..'" só em
    // produção (funciona local pq o node_modules inteiro tá em disco).
    '/reseller/creditos': [
      './node_modules/tesseract.js/**/*',
      './node_modules/tesseract.js-core/**/*',
      './node_modules/wasm-feature-detect/**/*',
    ],
  },
};

export default nextConfig;
