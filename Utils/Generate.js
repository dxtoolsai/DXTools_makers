// Generates keypairs and saves them to a folder
const { Keypair, Connection } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '../config.json');
if (!fs.existsSync(configPath)) {
   throw new Error('Configuration file "config.json" not found!');
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const { RPC_URL, SOURCE_KEYPAIR_PATH } = config.general;
const { TRANSFER_AMOUNT } = config.transfer;
const { KEYPAIR_QTY } = config.generate;

const outputDir = path.join(__dirname, '../keypairs');
const MIN_BALANCE_SOL = 0.02; // Minimum balance for fees

if (!fs.existsSync(outputDir)) {
   fs.mkdirSync(outputDir);
}

async function generateKeypairs() {
   const connection = new Connection(RPC_URL, 'confirmed');
   const sourceKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(SOURCE_KEYPAIR_PATH, 'utf-8'))));

   const sourceBalance = await connection.getBalance(sourceKeypair.publicKey);
   console.log(`Source wallet balance: ${(sourceBalance / 1e9).toFixed(9)} SOL`);

   const lamportsToSend = Math.floor(TRANSFER_AMOUNT * 1e9);
   const minBalanceLamports = Math.floor(MIN_BALANCE_SOL * 1e9);

   const maxKeypairsFromBalance = Math.floor((sourceBalance - minBalanceLamports) / lamportsToSend);

   if (sourceBalance < minBalanceLamports) {
      console.log('Insufficient balance to generate any keypairs while keeping the minimum wallet balance.');
      return;
   }

   const keypairsToGenerate = Math.min(KEYPAIR_QTY, maxKeypairsFromBalance);

   if (keypairsToGenerate < KEYPAIR_QTY) {
      console.log(`Insufficient balance to generate ${KEYPAIR_QTY} keypairs. Generating ${keypairsToGenerate} keypairs instead.`);
   } else {
      console.log(`Generating ${KEYPAIR_QTY} keypairs.`);
   }

   for (let i = 0; i < keypairsToGenerate; i++) {
      const keypair = Keypair.generate();

      const publicKey = keypair.publicKey.toBase58();
      const keypairArray = Array.from(keypair.secretKey);

      const filePath = path.join(outputDir, `${publicKey}.json`);

      fs.writeFileSync(filePath, JSON.stringify(keypairArray));
   }

   console.log('Keypair generation completed.');
   console.log(`Remaining wallet balance: ${((sourceBalance - keypairsToGenerate * lamportsToSend) / 1e9).toFixed(9)} SOL`);
}

generateKeypairs().catch((err) => {
   console.error('Error generating keypairs:', err);
});
