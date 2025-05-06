// Checks that each wallet has the correct amount of sol and transfers to it if not
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');

const configPath = path.join(__dirname, '../config.json');
if (!fs.existsSync(configPath)) {
   throw new Error('Configuration file "config.json" not found!');
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const { RPC_URL, SOURCE_KEYPAIR_PATH } = config.general;
const { TRANSFER_AMOUNT } = config.transfer;

const RECIPIENTS_FOLDER = path.join(__dirname, '../keypairs');
const MIN_BALANCE_THRESHOLD = 0.00001;
const MAX_RETRIES = 3;

async function delay(ms) {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkAndDistributeSol() {
   console.log('Checking wallet balances in 5 seconds...');
   await delay(5000);

   const connection = new Connection(RPC_URL, 'confirmed');
   const sourceKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(SOURCE_KEYPAIR_PATH, 'utf-8'))));

   console.log(`Source wallet: ${sourceKeypair.publicKey.toBase58()}`);

   const sourceBalance = await connection.getBalance(sourceKeypair.publicKey);
   console.log(`Source wallet balance: ${(sourceBalance / 1e9).toFixed(9)} SOL`);

   const recipientFiles = fs.readdirSync(RECIPIENTS_FOLDER);
   console.log(`Found ${recipientFiles.length} wallets.`);

   const lamportsToSend = Math.floor(TRANSFER_AMOUNT * 1e9);
   const minLamportsThreshold = Math.floor(MIN_BALANCE_THRESHOLD * 1e9);

   for (const recipientFile of recipientFiles) {
      const recipientPublicKey = new PublicKey(path.basename(recipientFile, '.json'));

      try {
         const balance = await connection.getBalance(recipientPublicKey);

         if (balance <= minLamportsThreshold) {
            console.log(`Wallet ${recipientPublicKey.toBase58()} has ${(balance / 1e9).toFixed(9)} SOL. Transferring ${TRANSFER_AMOUNT} SOL...`);

            const transaction = new Transaction().add(
               SystemProgram.transfer({
                  fromPubkey: sourceKeypair.publicKey,
                  toPubkey: recipientPublicKey,
                  lamports: lamportsToSend,
               })
            );

            let retries = 0;
            let success = false;

            while (retries < MAX_RETRIES && !success) {
               try {
                  const signature = await sendAndConfirmTransaction(connection, transaction, [sourceKeypair]);
                  console.log(`Transfer successful: https://solscan.io/tx/${signature}`);
                  success = true;
               } catch (error) {
                  retries += 1;
                  console.error(`Failed to transfer to ${recipientPublicKey.toBase58()} on attempt ${retries}:`, error);

                  if (retries >= MAX_RETRIES) {
                     console.error(`Transfer to ${recipientPublicKey.toBase58()} failed after ${MAX_RETRIES} attempts.`);
                  } else {
                     console.log('Retrying...');
                  }
               }
            }
         } else {
            //console.log(`Wallet ${recipientPublicKey.toBase58()} has sufficient balance: ${(balance / 1e9).toFixed(9)} SOL`);
         }
      } catch (error) {
         console.error(`Error checking balance for ${recipientPublicKey.toBase58()}:`, error);
      }

      await delay(50);
   }

   console.log('Balance check and distribution complete.');
}

checkAndDistributeSol().catch((err) => {
   console.error('Error in balance check and distribution:', err);
});
