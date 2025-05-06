// Swaps SOL for the tokens. Runs in a loop until all wallets contain tokens
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const axios = require('axios');
const { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const { API_URLS } = require('@raydium-io/raydium-sdk-v2');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

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
const computeUnitPriceMicroLamports = PRIORITY_FEE_MICROLAMPORTS;
const delayBetweenTxMs = 1000;
const tokenFile = path.join(__dirname, `../wallets_with_tokens_${outputMint}.txt`);

let failedSwaps = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createConnection = () => new Connection(RPC_URL);

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
         .map((file) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(folderPath, file), 'utf8')))));
   } catch (error) {
      console.error('Failed to load keypairs:', error.message);
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
      console.error(`Failed to fetch token balance for ${walletPublicKey.toBase58()}:`, error.message);
      return 0;
   }
};

const performSwap = async (keypair) => {
   const walletPublicKey = keypair.publicKey;
   const inputMint = NATIVE_MINT.toBase58();

   try {
      const { data: swapResponse } = await axios.get(
         `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${swapAmountLamports}&slippageBps=50&txVersion=V0`
      );

      const { data: swapTransactions } = await axios.post(`${API_URLS.SWAP_HOST}/transaction/swap-base-in`, {
         swapResponse,
         txVersion: 'V0',
         wallet: walletPublicKey.toBase58(),
         wrapSol: true,
         unwrapSol: true,
         computeUnitPriceMicroLamports: computeUnitPriceMicroLamports.toString(),
      });

      if (!swapTransactions?.data?.length) {
         throw new Error('No transaction data received from Raydium API.');
      }

      const transactionBuffer = Buffer.from(swapTransactions.data[0].transaction, 'base64');
      const transaction = VersionedTransaction.deserialize(transactionBuffer);

      transaction.sign([keypair]);
      const connection = createConnection();
      const txId = await connection.sendTransaction(transaction, { skipPreflight: true });
      //console.log(`Transaction submitted for wallet ${walletPublicKey.toBase58()}, txId: ${txId}`);
   } catch (error) {
      console.error(`Error in performSwap for ${walletPublicKey.toBase58()}:`, error.message);

      if (error.response?.status === 429) {
         console.warn('Rate limit hit (429). Waiting 90 seconds');
         await delay(90000);
      } else {
         console.error('Critical error in performSwap. Restarting script...');
         restartScript();
      }
   }
};

const restartScript = () => {
   console.error('Restarting script due to critical error...');
   const child = spawn('node', [path.join(__dirname, 'swap.js')], { stdio: 'inherit' });

   child.on('exit', (code) => {
      if (code !== 0) {
         console.error(`Child process exited with error code ${code}. Restarting in 5 seconds...`);
         setTimeout(restartScript, 5000);
      }
   });

   child.on('error', (error) => {
      console.error('Error spawning child process:', error.message);
      console.error('Retrying script restart in 5 seconds...');
      setTimeout(restartScript, 5000);
   });
};

const getSolBalance = async (walletPublicKey) => {
   const connection = createConnection();
   try {
      const balance = await connection.getBalance(walletPublicKey);
      return balance / LAMPORTS_PER_SOL;
   } catch (error) {
      console.error(`Failed to fetch SOL balance for ${walletPublicKey.toBase58()}:`, error.message);
      return 0;
   }
};

const main = async () => {
   try {
      console.log('Loading keypairs...');
      const keypairs = loadKeypairs(keypairFolder);

      while (true) {
         try {
            console.log('Waiting 20 seconds to confirm previous transactions...');
            await delay(20000); // Delay for blockchain updates

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
                     await performSwap(keypair);
                     console.log(`Raydium swap attempted for wallet ${keypair.publicKey.toBase58()}.`);
                  } catch (error) {
                     console.error(`Error swapping wallet ${keypair.publicKey.toBase58()}:`, error.message);
                     failedSwaps.push(keypair.publicKey.toBase58());
                  }

                  await delay(delayBetweenTxMs);
               }
            }
         } catch (error) {
            console.error('Error in main loop iteration:', error.message);
            throw error;
         }
      }
   } catch (error) {
      console.error('Critical error in main:', error.message);
      restartScript();
   }
};

main().catch((error) => {
   console.error('Unexpected top-level error:', error.message);
   restartScript();
});
