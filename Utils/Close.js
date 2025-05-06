//Transfers tokens back to the funding wallet, closes the token accounts & sends the recovered SOL directly back to the funding wallet and transfers any remaining sol back to the funding wallet
const fs = require('fs');
const path = require('path');
const {
   Connection,
   Keypair,
   PublicKey,
   Transaction,
   sendAndConfirmTransaction,
   ComputeBudgetProgram,
   SystemProgram,
   SendTransactionError,
} = require('@solana/web3.js');
const {
   getMint,
   getTransferFeeConfig,
   createTransferCheckedInstruction,
   createHarvestWithheldTokensToMintInstruction,
   createCloseAccountInstruction,
   TOKEN_PROGRAM_ID,
   TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');
require('dotenv').config();

const { TOKEN_PROGRAM_TYPE } = process.env;
if (!TOKEN_PROGRAM_TYPE || !['SPL_TOKEN', 'SPL_2022_TOKEN'].includes(TOKEN_PROGRAM_TYPE)) {
   throw new Error(`
    Invalid or missing TOKEN_PROGRAM_TYPE in .env file. Expected 'SPL_TOKEN' or 'SPL_2022_TOKEN'.
  `);
}
const selectedTokenProgramId = TOKEN_PROGRAM_TYPE === 'SPL_2022_TOKEN' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

const configPath = path.join(__dirname, '../config.json');
if (!fs.existsSync(configPath)) {
   throw new Error('Configuration file "config.json" not found!');
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const { RPC_URL } = config.general;
const { PRIORITY_FEE_MICROLAMPORTS } = config.close;

const RPC_ENDPOINT = RPC_URL;
const DESTINATION_PUBLIC_KEY = process.env.DESTINATION_PUBLIC_KEY;
const DESTINATION_TOKEN_ACCOUNT = new PublicKey(process.env.DESTINATION_TOKEN_ACCOUNT);
const TokenMint = new PublicKey(process.env.TOKEN_MINT);
const decimals = parseInt(process.env.TOKEN_DECIMALS, 10);
const KEYPAIRS_FOLDER = path.join(__dirname, '../keypairs');
const DELAY_MS = 1000;
const batchAmount = 10;
const computeLimit = 15000;
const priorityFee = PRIORITY_FEE_MICROLAMPORTS;
const maxRetries = 3;

console.log(`Funding and Receiving wallet: ${DESTINATION_PUBLIC_KEY}`);
console.log(`Using Token Program Type: ${TOKEN_PROGRAM_TYPE}`);

const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
   units: computeLimit,
});
const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
   microLamports: priorityFee,
});

const transferFee = Math.round((priorityFee * computeLimit) / 1_000_000 + 5000);

const connection = new Connection(RPC_ENDPOINT);

async function delay(ms) {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

// Not currently being used. Kept in for possible future edits
// async function getNewerFeeFromMint(mintPubkey) {
//    const mintInfo = await getMint(connection, mintPubkey, 'confirmed', TOKEN_2022_PROGRAM_ID);

//    const fullFeeConfig = getTransferFeeConfig(mintInfo);
//    if (!fullFeeConfig) {
//       console.log('No recognised TransferFeeConfig found.');
//       return null;
//    }

//    const { newerTransferFee } = fullFeeConfig;
//    if (!newerTransferFee) {
//       console.log('No newerTransferFee found, returning null.');
//       return null;
//    }

//    console.log('newerTransferFee:', newerTransferFee);
//    return newerTransferFee;
// }

async function transferHarvestCloseSend(walletKeypair, destinationPublicKey, tokenAccountPubkey, accountBalanceRaw) {
   for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
         const walletBalance = await connection.getBalance(walletKeypair.publicKey);
         if (walletBalance <= transferFee) {
            throw new Error('Insufficient SOL to cover transaction fees.');
         }
         const solAmount = walletBalance - transferFee;

         const transaction = new Transaction();
         const { blockhash } = await connection.getLatestBlockhash();
         transaction.recentBlockhash = blockhash;
         transaction.feePayer = walletKeypair.publicKey;

         transaction.add(modifyComputeUnits).add(addPriorityFee);
         transaction.add(
            createTransferCheckedInstruction(
               tokenAccountPubkey,
               TokenMint,
               DESTINATION_TOKEN_ACCOUNT,
               walletKeypair.publicKey,
               accountBalanceRaw,
               decimals,
               [],
               selectedTokenProgramId
            )
         );

         if (TOKEN_PROGRAM_TYPE === 'SPL_2022_TOKEN') {
            const harvestIx = createHarvestWithheldTokensToMintInstruction(TokenMint, [tokenAccountPubkey], TOKEN_2022_PROGRAM_ID);
            transaction.add(harvestIx);
         }

         transaction.add(
            createCloseAccountInstruction(
               tokenAccountPubkey,
               new PublicKey(DESTINATION_PUBLIC_KEY),
               walletKeypair.publicKey,
               [],
               selectedTokenProgramId
            )
         );

         transaction.add(
            SystemProgram.transfer({
               fromPubkey: walletKeypair.publicKey,
               toPubkey: new PublicKey(destinationPublicKey),
               lamports: solAmount,
            })
         );

         const signature = await sendAndConfirmTransaction(connection, transaction, [walletKeypair], {
            skipPreflight: true,
            commitment: 'processed',
         });

         //console.log(`Transaction successful: https://solscan.io/tx/${signature}`);
         return signature;
      } catch (error) {
         const msg = error?.message ?? 'Unknown error';
         console.error(`Error in transaction attempt ${attempt}: ${msg}`);

         if (error instanceof SendTransactionError && error.logs) {
            console.error('Transaction logs:');
            error.logs.forEach((log) => console.error(log));
         }

         if (attempt === maxRetries) throw error;

         if (msg.includes('block height exceeded')) {
            console.log('Transaction expired. Retrying...');
         } else {
            console.log('Retrying transaction...');
         }
         await delay(DELAY_MS);
      }
   }
}

async function processWallet(filePath) {
   try {
      const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf8'))));
      const walletPublicKey = keypair.publicKey;

      const tokenAccounts = await connection.getTokenAccountsByOwner(walletPublicKey, {
         programId: selectedTokenProgramId,
      });

      await delay(500);

      for (const account of tokenAccounts.value) {
         const tokenAccountPubkey = new PublicKey(account.pubkey);
         const accountInfo = await connection.getParsedAccountInfo(tokenAccountPubkey);
         const tokenBalance = accountInfo.value?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

         if (tokenBalance > 0) {
            //console.log(`Wallet ${walletPublicKey.toBase58()} has ${tokenBalance} tokens in: ${account.pubkey}`);
            const accountBalanceRaw = BigInt(Math.round(tokenBalance * 10 ** decimals));

            await transferHarvestCloseSend(keypair, DESTINATION_PUBLIC_KEY, tokenAccountPubkey, accountBalanceRaw);
         }
      }

      await delay(DELAY_MS);
   } catch (error) {
      console.error(`Error processing wallet: ${filePath}, error: ${error.message}`);
   }
}

async function main() {
   const keypairFiles = fs.readdirSync(KEYPAIRS_FOLDER).filter((file) => file.endsWith('.json'));

   if (keypairFiles.length === 0) {
      console.log('No keypair files found in the keypairs folder.');
      return;
   }

   console.log(`Found ${keypairFiles.length} keypair files. Starting processing...`);

   const batchSize = batchAmount;
   for (let i = 0; i < keypairFiles.length; i += batchSize) {
      const batch = keypairFiles.slice(i, i + batchSize);

      let tokensFound = false;
      await Promise.all(
         batch.map(async (file) => {
            const filePath = path.join(KEYPAIRS_FOLDER, file);
            await processWallet(filePath);
            tokensFound = true;
         })
      );

      console.log(`Processed batch ${Math.ceil((i + batchSize) / batchSize)} of ${Math.ceil(keypairFiles.length / batchSize)}`);

      if (!tokensFound) {
         console.log('No tokens found in the current batch.');
      }
   }

   console.log('Processing complete.');
}

main().catch(console.error);
