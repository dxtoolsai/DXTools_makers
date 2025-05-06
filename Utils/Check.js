//Checks the wallets for any remaining SOL/Tokens and moves the wallets to a different folder.
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
require('dotenv').config();

const { TOKEN_PROGRAM_TYPE } = process.env;
if (!TOKEN_PROGRAM_TYPE || !['SPL_TOKEN', 'SPL_2022_TOKEN'].includes(TOKEN_PROGRAM_TYPE)) {
   throw new Error(`Invalid or missing TOKEN_PROGRAM_TYPE in .env file. Expected 'SPL_TOKEN' or 'SPL_2022_TOKEN'.`);
}

const selectedTokenProgramId = TOKEN_PROGRAM_TYPE === 'SPL_2022_TOKEN' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

const configPath = path.join(__dirname, '../config.json');
if (!fs.existsSync(configPath)) {
   throw new Error('Configuration file "config.json" not found!');
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const { RPC_URL } = config.general;

const connection = new Connection(RPC_URL, 'confirmed');

const KEYPAIRS_FOLDER = '././keypairs';
const CHECK_FOLDER = '././keypairs_check';
const OLD_FOLDER = '././keypairs_old';
const RATE_LIMIT_DELAY_MS = 50;

if (!fs.existsSync(CHECK_FOLDER)) fs.mkdirSync(CHECK_FOLDER);
if (!fs.existsSync(OLD_FOLDER)) fs.mkdirSync(OLD_FOLDER);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkWallet(walletFile) {
   const walletPath = path.join(KEYPAIRS_FOLDER, walletFile);
   const publicKey = new PublicKey(walletFile.replace('.json', ''));

   try {
      const solBalance = await connection.getBalance(publicKey);

      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
         programId: selectedTokenProgramId,
      });

      const hasTokens = tokenAccounts.value.some((account) => {
         const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
         return balance > 0;
      });

      const destinationFolder = solBalance > 0 || tokenAccounts.value.length > 0 || hasTokens ? CHECK_FOLDER : OLD_FOLDER;

      // Move the keypairs
      const destinationPath = path.join(destinationFolder, walletFile);
      fs.renameSync(walletPath, destinationPath);

      console.log(
         `Wallet ${publicKey.toBase58()} processed: SOL balance = ${solBalance}, Token accounts = ${
            tokenAccounts.value.length
         }. Moved to ${destinationFolder}`
      );
   } catch (error) {
      console.error(`Error processing wallet ${walletFile}:`, error.message);
   }
}

async function processKeypairs() {
   const walletFiles = fs.readdirSync(KEYPAIRS_FOLDER).filter((file) => file.endsWith('.json'));

   console.log(`Found ${walletFiles.length} wallets. Starting processing...`);

   for (const walletFile of walletFiles) {
      await checkWallet(walletFile);
      await delay(RATE_LIMIT_DELAY_MS);
   }

   console.log('Processing complete.');
}

async function ensureAllKeypairsProcessed() {
   await processKeypairs();

   const remainingFiles = fs.readdirSync(KEYPAIRS_FOLDER).filter((file) => file.endsWith('.json'));

   if (remainingFiles.length > 0) {
      console.log(`${remainingFiles.length} keypairs still in ${KEYPAIRS_FOLDER}. Retrying...`);
      await processKeypairs();

      const finalRemainingFiles = fs.readdirSync(KEYPAIRS_FOLDER).filter((file) => file.endsWith('.json'));

      if (finalRemainingFiles.length > 0) {
         console.log(`${finalRemainingFiles.length} keypairs could not be processed. Moving them to ${CHECK_FOLDER}.`);

         for (const file of finalRemainingFiles) {
            const sourcePath = path.join(KEYPAIRS_FOLDER, file);
            const destinationPath = path.join(CHECK_FOLDER, file);
            fs.renameSync(sourcePath, destinationPath);
         }
      } else {
         console.log('All keypairs successfully processed.');
      }
   }
}

ensureAllKeypairsProcessed().catch((error) => console.error('Error in ensureAllKeypairsProcessed function:', error));
