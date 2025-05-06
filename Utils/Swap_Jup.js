//Swap script used for Token 2022 swaps
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const axios = require('axios');
const { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const { spawn } = require('child_process');

const { transactionSenderAndConfirmationWaiter } = require('./TransactionSenderAndConfirmationWaiter');

dotenv.config();
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
const { TOKEN_MINT, SOL_TO_SWAP, PRIORITY_FEE_MICROLAMPORTS } = config.swap;

const keypairFolder = path.join(__dirname, '../keypairs');
const outputMint = TOKEN_MINT;
const swapAmountLamports = SOL_TO_SWAP * LAMPORTS_PER_SOL;
const delayBetweenTxMs = 1200;
const tokenFile = path.join(__dirname, `../wallets_with_tokens_${outputMint}.txt`);
const createConnection = () => new Connection(RPC_URL);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loadWalletsWithTokens = () => {
   if (!fs.existsSync(tokenFile)) {
      fs.writeFileSync(tokenFile, '', 'utf8');
   }
   const data = fs.readFileSync(tokenFile, 'utf8');
   return new Set(data.split('\n').filter(Boolean));
};

const saveWalletWithTokens = (walletAddress) => {
   fs.appendFileSync(tokenFile, `${walletAddress}\n`, 'utf8');
};

const loadKeypairs = (folderPath) => {
   try {
      return fs
         .readdirSync(folderPath)
         .filter((file) => file.endsWith('.json'))
         .map((file) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(folderPath, file), 'utf-8')))));
   } catch (error) {
      console.error('Failed to load keypairs:', error?.message || error);
      return [];
   }
};

const getTokenBalance = async (walletPublicKey, mintAddress) => {
   const connection = createConnection();
   try {
      const mintPublicKey = new PublicKey(mintAddress);
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPublicKey, {
         mint: mintPublicKey,
         programId: selectedTokenProgramId,
      });
      if (tokenAccounts.value.length > 0) {
         const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
         return balance || 0;
      }
      return 0;
   } catch (error) {
      console.error(`Failed to fetch token balance for ${walletPublicKey.toBase58()}:`, error?.message || error);
      return 0;
   }
};

const performSwapWithJupiter = async (keypair) => {
   const walletPublicKey = keypair.publicKey.toString();
   const connection = createConnection();

   try {
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${NATIVE_MINT.toBase58()}&outputMint=${outputMint}&amount=${swapAmountLamports}&slippageBps=500&restrictIntermediateTokens=true&onlyDirectRoutes=true`;
      const { data: quoteResponse } = await axios.get(quoteUrl);

      if (!quoteResponse) {
         throw new Error('Failed to fetch quote from Jupiter API.');
      }

      await delay(delayBetweenTxMs)

      const swapUrl = `https://quote-api.jup.ag/v6/swap`;
      const { data: swapResponse } = await axios.post(
         swapUrl,
         {
            quoteResponse,
            userPublicKey: walletPublicKey,
            wrapAndUnwrapSol: true,
            computeUnitPriceMicroLamports: PRIORITY_FEE_MICROLAMPORTS,
            dynamicComputeUnitLimit: true,
         },
         {
            headers: { 'Content-Type': 'application/json' },
         }
      );

      if (!swapResponse?.swapTransaction) {
         throw new Error('Failed to fetch swap transaction from Jupiter API.');
      }

      const transactionBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuffer);
      transaction.sign([keypair]);

      const latestBlockHash = await connection.getLatestBlockhash();
      const rawTransaction = transaction.serialize();

      const txResponse = await transactionSenderAndConfirmationWaiter({
         connection,
         serializedTransaction: rawTransaction,
         blockhashWithExpiryBlockHeight: {
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
         },
      });

      if (!txResponse) {
         console.error(`Jupiter Transaction submitted for wallet ${walletPublicKey}`);
         return;
      }

      const confirmedSignature = txResponse?.transaction?.signatures?.[0];
      if (confirmedSignature) {
         console.log(`Swap successful for wallet ${walletPublicKey}. Transaction ID: https://solscan.io/tx/${confirmedSignature}`);
      } else {
         console.log(`Swap response for wallet ${walletPublicKey} confirmed, but no signature found.`);
      }
   } catch (error) {
      if (error.response?.status === 429) {
         console.error(`Rate limit hit for wallet ${walletPublicKey}:`, error?.message || error);
         console.error('Pausing script for 140 seconds due to rate-limiting (Error 429)...');
         await delay(140000);
         throw error;
      } else {
         console.error(`Swap error for ${walletPublicKey}:`, error?.message || error);
         throw error;
      }
   }
};

const restartScript = (pauseBeforeRestart = false) => {
   if (pauseBeforeRestart) {
      console.error('Pausing script for 140 seconds due to rate-limiting (Error 429)...');
      setTimeout(() => {
         console.error('Restarting script after pause...');
         spawnChildProcess();
      }, 140000);
   } else {
      console.error('Restarting script due to error...');
      spawnChildProcess();
   }
};

const spawnChildProcess = () => {
   const child = spawn('node', [path.join(__dirname, 'swap_jup.js')], { stdio: 'inherit' });

   child.on('exit', (code) => {
      if (code !== 0) {
         console.error('Script exited with error. Restarting...');
         setTimeout(() => restartScript(), 5000);
      }
   });
};

const getSolBalance = async (walletPublicKey) => {
   const connection = createConnection();
   try {
      const balance = await connection.getBalance(walletPublicKey);
      return balance / LAMPORTS_PER_SOL;
   } catch (error) {
      console.error(`Failed to fetch SOL balance for ${walletPublicKey.toBase58()}:`, error?.message || error);
      return 0;
   }
};

// Main loop
const main = async () => {
   try {
      console.log('Loading keypairs...');
      const keypairs = loadKeypairs(keypairFolder);

      while (true) {
         console.log('Waiting 20 seconds to confirm previous transactions...');
         await delay(20000);

         console.log('Checking token balances and preparing wallets for swaps...');
         const walletsToSwap = [];
         const walletsWithTokens = loadWalletsWithTokens();

         for (const keypair of keypairs) {
            const walletAddress = keypair.publicKey.toBase58();

            if (walletsWithTokens.has(walletAddress)) {
               console.log(`Wallet ${walletAddress} already has tokens. Skipping.`);
               continue;
            }

            const tokenBalance = await getTokenBalance(keypair.publicKey, outputMint);
            const solBalance = await getSolBalance(keypair.publicKey);

            if (tokenBalance > 0 || solBalance === 0) {
               console.log(`Wallet ${walletAddress} has ${tokenBalance} tokens or 0 SOL. Adding to token file.`);
               walletsWithTokens.add(walletAddress);
               saveWalletWithTokens(walletAddress);
            } else {
               walletsToSwap.push(keypair);
            }
         }

         if (walletsToSwap.length === 0) {
            console.log('All wallets verified to hold tokens or lack SOL. Exiting script.');
            process.exit(0);
         } else {
            console.log(`${walletsToSwap.length} wallets require swaps. Starting transactions...`);
            for (const keypair of walletsToSwap) {
               try {
                  await performSwapWithJupiter(keypair);
               } catch (error) {
                  console.error(`Error swapping wallet ${keypair.publicKey.toBase58()}:`, error?.message || error);
               }
               // Delay between each swap
               await delay(delayBetweenTxMs);
            }
         }
      }
   } catch (error) {
      console.error('Error in main loop:', error?.message || error);
      restartScript();
   }
};

main().catch((error) => {
   console.error('Unexpected error:', error?.message || error);
   restartScript();
});
