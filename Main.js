const fs = require("fs");
const path = require("path");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const {
  getMint,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");
const { spawn } = require("child_process");

const logFilePath = path.join(__dirname, "makers.log");
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
  const message = args.join(" ");
  originalLog(message);
  fs.appendFileSync(logFilePath, message + "\n");
};

console.error = function (...args) {
  const message = args.join(" ");
  originalError(message);
  fs.appendFileSync(logFilePath, "[ERROR] " + message + "\n");
};

const args = process.argv.slice(2);
const validStages = ["generate", "transfer", "swap", "close", "check"];
const startFromArg = args
  .find((arg) => arg.startsWith("--"))
  ?.replace("--", "")
  .toLowerCase();

if (startFromArg && !validStages.includes(startFromArg)) {
  console.error(
    `Invalid flag: ${startFromArg}. Valid options are: ${validStages.join(
      ", "
    )}`
  );
  process.exit(1);
}

const START_FROM = startFromArg || "generate";

const configPath = path.join(__dirname, "./config.json");
if (!fs.existsSync(configPath)) {
  throw new Error('Configuration file "config.json" not found!');
}
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const rpcUrl = config.general.RPC_URL;
const keypairPath = config.general.SOURCE_KEYPAIR_PATH;
const tokenMint = config.swap.TOKEN_MINT;
const envFilePath = path.resolve(__dirname, ".env");

const connection = new Connection(rpcUrl, "confirmed");
const delayBetweenLoops = 20_000;
const delayBetweenScripts = 10_000;

async function determineTokenProgramType(mintAddress) {
  try {
    const accountInfo = await connection.getAccountInfo(
      new PublicKey(mintAddress),
      "finalized"
    );
    if (!accountInfo) {
      throw new Error(`Failed to fetch account info for mint: ${mintAddress}`);
    }

    const programId = accountInfo.owner.toBase58();
    if (programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
      console.log(`Token is using SPL_2022_TOKEN.`);
      return "SPL_2022_TOKEN";
    } else if (programId === TOKEN_PROGRAM_ID.toBase58()) {
      console.log(`Token is using SPL_TOKEN.`);
      return "SPL_TOKEN";
    } else {
      throw new Error(`Unknown program ID for mint: ${programId}`);
    }
  } catch (error) {
    console.error(`Failed to determine token program type: ${error.message}`);
    throw error;
  }
}

async function determineSwapScript() {
  try {
    const tokenProgramType = await determineTokenProgramType(tokenMint);

    if (tokenProgramType === "SPL_2022_TOKEN") {
      console.log(`Swapping via Jupiter`);
      return path.join(__dirname, "./Utils/Swap_Jup.js");
    } else if (tokenProgramType === "SPL_TOKEN") {
      console.log(`Swapping via Raydium`);
      return path.join(__dirname, "./Utils/Swap.js");
    } else {
      throw new Error("Unknown TOKEN_PROGRAM_TYPE detected.");
    }
  } catch (error) {
    console.error(`Failed to determine swap script: ${error.message}`);
    throw error;
  }
}

async function generateEnvFile() {
  try {
    if (!fs.existsSync(keypairPath)) {
      throw new Error(`Keypair file not found at path: ${keypairPath}`);
    }

    const keypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")))
    );
    const publicKey = keypair.publicKey.toBase58();
    console.log(`Wallet Public Key: ${publicKey}`);

    const tokenProgramType = await determineTokenProgramType(tokenMint);

    const tokenMintPublicKey = new PublicKey(tokenMint);
    const mintInfo = await getMint(
      connection,
      tokenMintPublicKey,
      "confirmed",
      tokenProgramType === "SPL_2022_TOKEN"
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID
    );
    const tokenDecimals = mintInfo.decimals;

    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      keypair,
      tokenMintPublicKey,
      keypair.publicKey,
      false,
      "finalized",
      undefined,
      tokenProgramType === "SPL_2022_TOKEN"
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID
    );

    const tokenAccountAddress = tokenAccount.address.toBase58();

    const envContent = `
DESTINATION_PUBLIC_KEY=${publicKey}
DESTINATION_TOKEN_ACCOUNT=${tokenAccountAddress}
TOKEN_MINT=${tokenMint}
TOKEN_DECIMALS=${tokenDecimals}
TOKEN_PROGRAM_TYPE=${tokenProgramType}
    `.trim();

    fs.writeFileSync(envFilePath, envContent, "utf8");
    console.log(`.env file created successfully at: ${envFilePath}`);
  } catch (error) {
    console.error(`Failed to generate .env file: ${error.message}`);
    throw error;
  }
}

function runScript(script) {
  return new Promise((resolve) => {
    const executeScript = () => {
      const processCmd = spawn("node", [script], { stdio: "inherit" });

      processCmd.on("close", (code) => {
        if (code === 0) {
          console.log(`Script ${script} completed successfully.`);
          resolve();
        } else {
          console.error(
            `Script ${script} failed with exit code ${
              code || "null"
            }. Retrying in 10 seconds...`
          );
          setTimeout(executeScript, 10000);
        }
      });
    };

    executeScript();
  });
}

async function runScriptsSequentially(initialStart = "generate") {
  try {
    const swapScript = await determineSwapScript();
    const scripts = [
      { name: "generate", path: path.join(__dirname, "./Utils/Generate.js") },
      { name: "transfer", path: path.join(__dirname, "./Utils/Transfer.js") },
      {
        name: "transfer_check",
        path: path.join(__dirname, "./Utils/Transfer_Check.js"),
      },
      { name: "swap", path: swapScript },
      { name: "close", path: path.join(__dirname, "./Utils/Close.js") },
      { name: "close", path: path.join(__dirname, "./Utils/Close.js") },
      { name: "check", path: path.join(__dirname, "./Utils/Check.js") },
    ];

    const startIndex = scripts.findIndex(
      (script) => script.name === initialStart
    );
    if (startIndex === -1) {
      throw new Error(`Invalid starting script: ${initialStart}`);
    }

    for (let i = startIndex; i < scripts.length; i++) {
      const script = scripts[i];
      console.log(`Running script: ${script.name}`);
      await runScript(script.path);
      console.log(
        `Waiting ${delayBetweenScripts / 1000}s before running the next script.`
      );
      await new Promise((resolve) => setTimeout(resolve, delayBetweenScripts));
    }
  } catch (error) {
    console.error(`Error during script execution: ${error.message}`);
    process.exit(1);
  }
}

console.log(`__dirname is: ${__dirname}`);

function clearTokenFile() {
  const tokenFilePath = path.join(
    __dirname,
    `wallets_with_tokens_${config.swap.TOKEN_MINT}.txt`
  );
  if (fs.existsSync(tokenFilePath)) {
    fs.writeFileSync(tokenFilePath, "", "utf8");
    console.log(`Token file cleared at: ${tokenFilePath}`);
  } else {
    console.log(`Token file does not exist. No need to clear.`);
  }
}

async function main() {
  try {
    console.log(`Clearing token file...`);
    clearTokenFile();

    console.log(`Generating .env file...`);
    await generateEnvFile();

    console.log(`Starting scripts from: ${START_FROM}`);
    await runScriptsSequentially(START_FROM);

    if (!config.general.LOOP_ENABLED) {
      console.log("Looping is disabled. Exiting script.");
      return;
    }

    while (true) {
      console.log(`Running all scripts in subsequent loops.`);
      await runScriptsSequentially();
      console.log(
        `Waiting ${delayBetweenLoops / 1000}s before restarting the loop.`
      );
      await new Promise((resolve) => setTimeout(resolve, delayBetweenLoops));

      if (!config.general.LOOP_ENABLED) {
        console.log("Looping has been disabled. Exiting script.");
        break;
      }
    }
  } catch (error) {
    console.error(`Script failed: ${error.message}`);
    console.log("Restarting script in 10 seconds...");
    setTimeout(() => {
      main().catch(console.error);
    }, 10000);
  }
}

main().catch(console.error);
