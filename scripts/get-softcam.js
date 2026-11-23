// Downloads the AirCam virtual camera DLL (softcam built by .github/workflows/softcam.yml) into vendor/softcam/.
const fs = require('fs');
const path = require('path');

const BASE = 'https://github.com/kf5-io/AirCam/releases/download/softcam-v1.8.1/';
const dir = path.join(__dirname, '..', 'vendor', 'softcam');

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['softcam.dll', 'softcam-LICENSE.txt']) {
    const res = await fetch(BASE + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} (le workflow "softcam" a-t-il publié la release ?)`);
    fs.writeFileSync(path.join(dir, name), Buffer.from(await res.arrayBuffer()));
    console.log('ok', name);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
