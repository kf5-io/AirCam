// Downloads the virtual cameras built by CI: DirectShow (softcam, .github/workflows/softcam.yml) into vendor/softcam/
// and Media Foundation for Windows 11 (.github/workflows/mfcam.yml) into vendor/mfcam/.
const fs = require('fs');
const path = require('path');

const REL = 'https://github.com/kf5-io/AirCam/releases/download/';
const SETS = [
  ['softcam', 'softcam-v1.8.1', ['softcam.dll', 'softcam-LICENSE.txt']],
  ['mfcam', 'mfcam-v1', ['AirCamMF.dll', 'aircam-mfcam.exe', 'VCamSample-LICENSE.txt']],
];

(async () => {
  for (const [folder, tag, names] of SETS) {
    const dir = path.join(__dirname, '..', 'vendor', folder);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of names) {
      if (fs.existsSync(path.join(dir, name))) { console.log('déjà là', folder + '/' + name); continue; } // shortcut: delete vendor/ to update
      const res = await fetch(REL + tag + '/' + name);
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status} (la release "${tag}" a-t-elle été publiée par le CI ?)`);
      fs.writeFileSync(path.join(dir, name), Buffer.from(await res.arrayBuffer()));
      console.log('ok', folder + '/' + name);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
