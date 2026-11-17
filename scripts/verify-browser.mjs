// Compatibility entry point: the complete offline 3D browser verification.
// It uses real Cesium and the shipped Lux3D asset, without spending generation credits.
if (!process.argv.includes('--record') && !process.argv.includes('--no-video')) process.argv.push('--no-video');
await import('./verify-functional.mjs');
