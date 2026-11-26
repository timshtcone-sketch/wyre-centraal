// Maakt de site voor de eigen server: dezelfde index.html, maar met de Firebase-modules
// vervangen door fb-shim.js. Gebruik: node build.js <repo-map> <doelmap>
const fs = require('node:fs'), path = require('node:path');
const [repo, doel] = process.argv.slice(2);
let h = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
const re = /from\s+"https:\/\/www\.gstatic\.com\/firebasejs\/[^"]+\/firebase-(app|auth|firestore)\.js"/g;
const n = (h.match(re) || []).length;
if (n !== 3) { console.error('Verwachtte 3 Firebase-imports in index.html, vond er ' + n); process.exit(1); }
h = h.replace(re, 'from "./fb-shim.js"');
fs.mkdirSync(doel, { recursive: true });
fs.writeFileSync(path.join(doel, 'index.html'), h);
fs.copyFileSync(path.join(repo, 'uitrol-template.html'), path.join(doel, 'uitrol-template.html'));
fs.copyFileSync(path.join(__dirname, 'public', 'fb-shim.js'), path.join(doel, 'fb-shim.js'));
console.log('Site gebouwd in', doel);
