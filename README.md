# DexMaker

This script creates new keypairs and swaps a small amount of SOL for tokens to increase the 'Makers' count on DexScreener.

With the default settings, it costs approximately 0.05 SOL per 1,000 makers.

You may need a VPN to create more than 100 makers at a time. The Raydium API rate-limits based on IP addresses, so using a VPN with rotating IPs can help.

The script includes support for SPL Token 2022. It identifies the token program based on the mint address and swaps SOL using the Jupiter v6 API. For SPL Tokens, it continues to use Raydium because I found transactions land more consistently when using Raydium's SDK.

1. npm install

2. Update configuration details in config.js:

* RPC_URL: Add your own RPC endpoint here.

* SOURCE_KEYPAIR_PATH: Specify the path to your funding keypair. This keypair will fund the swaps and also receive the tokens and SOL when accounts are closed.

* KEYPAIR_QTY: Set the number of keypairs (or makers) you want to create. Since the script runs in a loop, keeping this number low helps avoid Raydium's IP limits. A recommended value is 100.

* TRANSFER_AMOUNT: Define the amount of SOL to transfer to each wallet. A recommended value is 0.0045 SOL, though you may be able to reduce this slightly depending on your priority fee settings.

* TOKEN_MINT: Specify the token mint address for the tokens you want to swap.

* SOL_TO_SWAP: Set the amount of SOL to swap for tokens. Keeping this value low is advisable. Even as low as 0.00001 SOL will still count as a 'Maker.' Note that Raydium charges at least a 0.25% fee per transaction, so minimizing this amount helps reduce costs.

* PRIORITY_FEE_MICROLAMPORTS (swap): Configure the priority fee for Raydium swaps. Adjust this to increase the likelihood of transactions being confirmed during congestion.

* PRIORITY_FEE_MICROLAMPORTS (close): Configure the priority fee for closing accounts. This fee can typically remain low but may need adjustment during busy periods to ensure transactions are confirmed.

3. npm start to start the script

** This is a work in progress. Please use at your own risk! **
