const fs = require('fs');
const path = require('path');
const { processAudioFile } = require('../../src/knowledge/transcribe');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.webm']);

function parseArgs(argv) {
  const args = {
    folderPath: argv[0] || process.cwd(),
    once: false
  };

  for (const arg of argv.slice(1)) {
    if (arg === '--once') {
      args.once = true;
    }
  }

  return args;
}

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function processFile(folderPath, fileName) {
  const absolutePath = path.join(folderPath, fileName);

  if (!isAudioFile(absolutePath)) {
    return null;
  }

  const result = await processAudioFile(absolutePath, {
    source: 'voice_memo'
  });
  const processedDir = path.join(folderPath, 'processed');

  await fs.promises.mkdir(processedDir, { recursive: true });
  await fs.promises.rename(absolutePath, path.join(processedDir, fileName));
  return result;
}

async function processExisting(folderPath) {
  const entries = await fs.promises.readdir(folderPath);

  for (const entry of entries) {
    if (entry === 'processed') {
      continue;
    }

    const result = await processFile(folderPath, entry);

    if (result) {
      console.log(JSON.stringify({ file: entry, result }, null, 2));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const folderPath = path.resolve(args.folderPath);

  await processExisting(folderPath);

  if (args.once) {
    return;
  }

  fs.watch(folderPath, async (_eventType, fileName) => {
    if (!fileName || fileName === 'processed') {
      return;
    }

    try {
      const result = await processFile(folderPath, fileName);

      if (result) {
        console.log(JSON.stringify({ file: fileName, result }, null, 2));
      }
    } catch (error) {
      console.error(`${fileName}: ${error.message}`);
    }
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
