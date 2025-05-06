//Transfers sol from the funding wallet to each keypair in the 'keypairs' folder
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram } = require('@solana/web3.js');

const configPath = path.join(__dirname, '../config.json');
if (!fs.existsSync(configPath)) {
   throw new Error('Configuration file "config.json" not found!');
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const { RPC_URL, SOURCE_KEYPAIR_PATH } = config.general;
const { TRANSFER_AMOUNT } = config.transfer;

const RECIPIENTS_FOLDER = path.join(__dirname, '../keypairs');
const BATCH_SIZE = 19;
const MAX_RETRIES = 3;

const computeLimit = 3150;
const priorityFee = 1000;

const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
   units: computeLimit,
});
const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
   microLamports: priorityFee,
});

async function delay(ms) {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

async function distributeSol() {
   console.log('Starting script in 5 seconds...');
   await delay(5000);

   const connection = new Connection(RPC_URL, 'confirmed');
   const sourceKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(SOURCE_KEYPAIR_PATH, 'utf-8'))));

   console.log(`Source wallet: ${sourceKeypair.publicKey.toBase58()}`);

   const recipientFiles = fs.readdirSync(RECIPIENTS_FOLDER);
   console.log(`Found ${recipientFiles.length} recipients.`);

   const lamportsToSend = Math.floor(TRANSFER_AMOUNT * 1e9);

   for (let i = 0; i < recipientFiles.length; i += BATCH_SIZE) {
      const batch = recipientFiles.slice(i, i + BATCH_SIZE);
      const transaction = new Transaction();

      transaction.add(modifyComputeUnits).add(addPriorityFee);

      for (const recipientFile of batch) {
         const recipientPublicKey = new PublicKey(path.basename(recipientFile, '.json'));
         transaction.add(
            SystemProgram.transfer({
               fromPubkey: sourceKeypair.publicKey,
               toPubkey: recipientPublicKey,
               lamports: lamportsToSend,
            })
         );
      }

      let retries = 0;
      let success = false;

      while (retries < MAX_RETRIES && !success) {
         try {
            console.log(`Sending batch ${Math.floor(i / BATCH_SIZE) + 1} with ${batch.length} transfers (Attempt ${retries + 1})...`);
            const signature = await sendAndConfirmTransaction(connection, transaction, [sourceKeypair]);
            console.log(`Batch successful https://solscan.io/tx/${signature}`);
            success = true;
         } catch (error) {
            retries += 1;
            console.error(`Failed to send batch ${Math.floor(i / BATCH_SIZE) + 1} on attempt ${retries}:`, error);

            if (retries >= MAX_RETRIES) {
               console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed after ${MAX_RETRIES} attempts. Moving on.`);
            } else {
               console.log('Retrying...');
            }
         }
      }
   }

   console.log('Distribution complete.');
}

distributeSol().catch((err) => {
   console.error('Error in distribution:', err);
});
