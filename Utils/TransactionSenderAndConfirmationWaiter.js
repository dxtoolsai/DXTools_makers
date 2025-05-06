// transactionSenderAndConfirmationWaiter.js. Taken from Jupiter V6 Repository

const promiseRetry = require('promise-retry');
const { TransactionExpiredBlockheightExceededError } = require('@solana/web3.js');

function wait(ms) {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

// This is the same send options used in the original Jupiter script
const SEND_OPTIONS = {
   skipPreflight: true,
   //commitment: "confirmed"
};

/**
 * transactionSenderAndConfirmationWaiter
 *
 * Sends a raw transaction and continually retries sending it until it is either
 * confirmed or expires due to block height constraints.
 *
 * @param {Object} params
 * @param {Connection} params.connection - A solana web3.js Connection object
 * @param {Buffer} params.serializedTransaction - The serialized transaction
 * @param {Object} params.blockhashWithExpiryBlockHeight - Contains `blockhash` and `lastValidBlockHeight`
 *
 * @returns {Promise<VersionedTransactionResponse | null>} The confirmed transaction response or null if expired
 */
async function transactionSenderAndConfirmationWaiter({ connection, serializedTransaction, blockhashWithExpiryBlockHeight }) {
   // 1. Send the transaction the first time and get the txid
   const txid = await connection.sendRawTransaction(serializedTransaction, SEND_OPTIONS);

   // 2. Prepare an abort controller so we can stop resending when done
   const controller = new AbortController();
   const abortSignal = controller.signal;

   // 3. This function resends the transaction every couple of seconds until aborted
   const abortableResender = async () => {
      while (true) {
         await wait(2000);
         if (abortSignal.aborted) return;

         try {
            await connection.sendRawTransaction(serializedTransaction, SEND_OPTIONS);
         } catch (e) {
            console.warn(`Failed to resend transaction: ${e?.message || e}`);
         }
      }
   };

   try {
      // Start that resend loop in the background
      abortableResender();

      // The Jupiter script subtracts 150 from lastValidBlockHeight to avoid immediate expiration
      const lastValidBlockHeight = blockhashWithExpiryBlockHeight.lastValidBlockHeight - 150;

      // 4. We race between:
      //    a) The confirmTransaction (websocket-based) call
      //    b) A fallback loop that checks getSignatureStatus in case the websocket is dead
      //
      //    This throws TransactionExpiredBlockheightExceededError if it times out.
      await Promise.race([
         connection.confirmTransaction(
            {
               ...blockhashWithExpiryBlockHeight,
               lastValidBlockHeight,
               signature: txid,
               abortSignal,
            },
            'confirmed'
         ),

         new Promise(async (resolve) => {
            while (!abortSignal.aborted) {
               await wait(2000);
               const txStatusResp = await connection.getSignatureStatus(txid, {
                  searchTransactionHistory: false,
               });
               if (txStatusResp?.value?.confirmationStatus === 'confirmed') {
                  resolve(txStatusResp);
                  return;
               }
            }
         }),
      ]);
   } catch (e) {
      // 5. If it’s a blockheight expiration, we just return null
      if (e instanceof TransactionExpiredBlockheightExceededError) {
         return null;
      } else {
         // Otherwise rethrow
         throw e;
      }
   } finally {
      // Stop the resend loop
      controller.abort();
   }

   // 6. In case the RPC isn't fully synced, we retry a few times to fetch the final transaction.
   //    If the transaction isn't found after retries, we return null.
   const response = await promiseRetry(
      async (retry) => {
         const txResponse = await connection.getTransaction(txid, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
         });
         if (!txResponse) {
            retry(new Error(`Transaction not found yet: ${txid}`));
         }
         return txResponse;
      },
      {
         retries: 5,
         minTimeout: 1000,
      }
   );

   return response;
}

module.exports = {
   transactionSenderAndConfirmationWaiter,
   wait,
};
