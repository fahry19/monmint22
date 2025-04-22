const ethers = require('ethers');
const puppeteer = require('puppeteer');
const dotenv = require('dotenv');
const CONFIG = require("./utils/config.js");
const displayHeader = require("./src/displayHeader.js");

dotenv.config();
displayHeader();

const RPC_URL = CONFIG.RPC_URL;
const EXPLORER_URL = 'https://testnet.monadexplorer.com/tx/';
const GAS_LIMIT = 500000;
const MAX_RETRY = 3;
const RETRY_DELAY = 100;
const GAS_MULTIPLIER = 2.5;

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const REQUEST_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'en-US,en;q=0.9,id;q=0.8',
  'origin': 'https://magiceden.io',
  'referer': 'https://magiceden.io/',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
};

function log(message) {
  console.log(`➤ ${message}`);
}

function getUserInput(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.once('data', (data) => resolve(data.toString().trim()));
  });
}

function detectLinkType(collectionLink) {
  if (collectionLink.includes('/mint-terminal/')) {
    return 'mint-terminal';
  } else if (collectionLink.includes('/launchpad/')) {
    return 'launchpad';
  } else {
    throw new Error('Invalid link: Must be either mint-terminal or launchpad');
  }
}

function convertMintTerminalLinkToApiUrl(collectionLink) {
  const match = collectionLink.match(/\/mint-terminal\/monad-testnet\/(0x[a-fA-F0-9]{40})/);
  if (!match) throw new Error('Invalid Magic Eden mint-terminal link');
  const contract = match[1];
  return `https://api-mainnet.magiceden.io/v3/rtp/monad-testnet/tokens/v7?tokens[]=${contract}:0&limit=1`;
}

function convertLaunchpadLinkToApiUrl(collectionLink) {
  const match = collectionLink.match(/\/launchpad\/(?:monad-testnet\/)?([^\/?]+)/);
  if (!match) throw new Error('Invalid Magic Eden launchpad link');
  const projectName = match[1];
  return `https://api-mainnet.magiceden.io/launchpads/${projectName}?edge_cache=true`;
}

let globalBrowser = null;

async function getBrowser() {
  if (!globalBrowser) {
    globalBrowser = await puppeteer.launch({ 
      headless: true, 
      args: ['--no-sandbox'],
      ignoreHTTPSErrors: true,
      defaultViewport: { width: 800, height: 600 }
    });
  }
  return globalBrowser;
}

async function closeBrowser() {
  if (globalBrowser) {
    await globalBrowser.close();
    globalBrowser = null;
  }
}

async function fetchMintTerminalStartTime(collectionId) {
  const apiUrl = 'https://api-mainnet.magiceden.io/v4/collections';
  const payload = {
    chain: 'monad-testnet',
    collectionIds: [collectionId],
    includeMintConfig: true
  };

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders(REQUEST_HEADERS);
    await page.setRequestInterception(true);

    page.on('request', (request) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
        request.abort();
      } else if (request.url() === apiUrl) {
        request.continue({
          method: 'POST',
          postData: JSON.stringify(payload),
          headers: {
            ...REQUEST_HEADERS,
            'Content-Type': 'application/json'
          }
        });
      } else {
        request.continue();
      }
    });

    await page.goto(apiUrl, { waitUntil: 'domcontentloaded' });
    const rawResponse = await page.evaluate(() => document.body.textContent);

    let jsonBody;
    try {
      jsonBody = JSON.parse(rawResponse);
    } catch (error) {
      log(`Error parsing response: ${error.message}`);
      await page.close();
      return null;
    }

    if (!jsonBody.collections || !jsonBody.collections.length) {
      log('Failed to fetch start time: No collection data');
      await page.close();
      return null;
    }

    const mintConfig = jsonBody.collections[0]?.chainData?.mintConfig;
    if (!mintConfig || !mintConfig.stages || !mintConfig.stages.length) {
      log('No mint stages found in response');
      await page.close();
      return null;
    }

    const stages = mintConfig.stages.map((stage, index) => ({
      startTime: new Date(stage.startTime).getTime() / 1000,
      priceWei: ethers.BigNumber.from(stage.price.raw),
      index: index
    }));

    await page.close();
    return stages;
  } catch (error) {
    log(`Error fetching start time: ${error.message}`);
    await page.close();
    return null;
  }
}

async function fetchLaunchpadDetails(apiUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders(REQUEST_HEADERS);
    await page.setRequestInterception(true);

    page.on('request', (request) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.goto(apiUrl, { waitUntil: 'domcontentloaded' });
    const rawResponse = await page.evaluate(() => document.body.textContent);

    let jsonBody;
    try {
      jsonBody = JSON.parse(rawResponse);
    } catch (error) {
      log(`Error parsing launchpad response: ${error.message}`);
      throw new Error('Invalid API response format');
    }

    if (!jsonBody.evm || !jsonBody.evm.contractAddress || !jsonBody.evm.stages) {
      log('Fetch error: Missing required launchpad data (evm, contractAddress, or stages)');
      throw new Error('Invalid API response structure');
    }

    const stages = jsonBody.evm.stages.map((stage, index) => ({
      startTime: new Date(stage.startTime).getTime() / 1000,
      priceWei: ethers.utils.parseEther(stage.price[0]),
      index: index
    }));

    const collection = {
      collectionId: jsonBody.evm.contractAddress,
      collectionName: jsonBody.name || 'Unnamed Launchpad',
      isMinting: jsonBody.evm.status === 'live' || jsonBody.evm.status === 'upcoming',
      protocol: jsonBody.contractType.toLowerCase() === 'erc1155' ? 'erc1155' : 'erc721',
      tokenId: '0'
    };

    await page.close();
    return { collections: [collection], stages };
  } catch (error) {
    log(`Fetch error: ${error.message}`);
    await page.close();
    return null;
  }
}

async function fetchMintTerminalLatestMints(apiUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders(REQUEST_HEADERS);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });
    
    await page.goto(apiUrl, { waitUntil: 'domcontentloaded' });
    const rawResponse = await page.evaluate(() => document.body.textContent);

    let jsonBody;
    try {
      jsonBody = JSON.parse(rawResponse);
    } catch (error) {
      log(`Error parsing v3 response: ${error.message}`);
      throw new Error('Invalid API response');
    }

    if (!jsonBody || !jsonBody.tokens || !Array.isArray(jsonBody.tokens)) {
      log('Fetch error: Invalid API response or no tokens found');
      throw new Error('Invalid API response');
    }

    const collections = jsonBody.tokens.map(token => ({
      collectionId: token.token.collection.id,
      collectionName: token.token.collection.name || 'Unnamed Collection',
      mintStages: token.token.mintStages || [],
      isMinting: token.token.isMinting !== undefined ? token.token.isMinting : true,
      protocol: token.token.kind || 'unknown',
      tokenId: token.token.tokenId || '0'
    }));
    log(`Found ${collections.length} collections`);
    await page.close();
    return collections;
  } catch (error) {
    log(`Fetch error: ${error.message}`);
    await page.close();
    return [];
  }
}

async function fetchMintTerminalCollectionsV4(collectionId) {
  const apiUrl = 'https://api-mainnet.magiceden.io/v4/collections';
  const payload = {
    chain: 'monad-testnet',
    collectionIds: [collectionId],
    includeMintConfig: true
  };

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders(REQUEST_HEADERS);
    await page.setRequestInterception(true);

    page.on('request', (request) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
        request.abort();
      } else if (request.url() === apiUrl) {
        request.continue({
          method: 'POST',
          postData: JSON.stringify(payload),
          headers: {
            ...REQUEST_HEADERS,
            'Content-Type': 'application/json'
          }
        });
      } else {
        request.continue();
      }
    });

    await page.goto(apiUrl, { waitUntil: 'domcontentloaded' });
    const rawResponse = await page.evaluate(() => document.body.textContent);

    let jsonBody;
    try {
      jsonBody = JSON.parse(rawResponse);
    } catch (error) {
      log(`Error parsing v4 response: ${error.message}`);
      throw new Error('Invalid API response');
    }

    if (!jsonBody || !jsonBody.collections || !Array.isArray(jsonBody.collections)) {
      log('Fetch error: Invalid API response or no collections found in v4');
      throw new Error('Invalid API response');
    }

    const collections = jsonBody.collections.map(collection => ({
      collectionId: collection.id,
      collectionName: collection.name || 'Unnamed Collection',
      mintStages: collection.chainData?.mintConfig?.stages || [],
      isMinting: true,
      protocol: collection.collectionType?.toLowerCase() || 'erc721',
      tokenId: '0'
    }));

    log(`Found ${collections.length} collections`);
    await page.close();
    return collections;
  } catch (error) {
    log(`Fetch error: ${error.message}`);
    await page.close();
    return [];
  }
}

async function fetchLatestMintsOrLaunchpad(collectionLink) {
  const linkType = detectLinkType(collectionLink);
  let apiUrl;

  if (linkType === 'mint-terminal') {
    apiUrl = convertMintTerminalLinkToApiUrl(collectionLink);
    let collections = await fetchMintTerminalLatestMints(apiUrl);

    if (!collections.length) {
      log('Fetch error: Invalid API response or no tokens found');
      const contractMatch = collectionLink.match(/\/mint-terminal\/monad-testnet\/(0x[a-fA-F0-9]{40})/);
      if (!contractMatch) {
        log('Invalid contract address in URL');
        return null;
      }
      const collectionId = contractMatch[1];
      collections = await fetchMintTerminalCollectionsV4(collectionId);
    }

    return { linkType, collections, stages: null };
  } else if (linkType === 'launchpad') {
    apiUrl = convertLaunchpadLinkToApiUrl(collectionLink);
    const result = await fetchLaunchpadDetails(apiUrl);
    if (!result) return null;
    return { linkType, collections: result.collections, stages: result.stages };
  }
}

async function checkAllowlistEligibility(collectionId) {
  const apiUrl = 'https://api-mainnet.magiceden.io/v4/self_serve/nft/check_allowlist_eligibility';
  const payload = {
    collectionId: collectionId,
    wallet: {
      chain: 'monad-testnet',
      address: wallet.address
    }
  };

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders(REQUEST_HEADERS);
    await page.setRequestInterception(true);

    page.on('request', (request) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
        request.abort();
      } else if (request.url() === apiUrl) {
        request.continue({
          method: 'POST',
          postData: JSON.stringify(payload),
          headers: {
            ...REQUEST_HEADERS,
            'Content-Type': 'application/json'
          }
        });
      } else {
        request.continue();
      }
    });

    await page.goto(apiUrl, { waitUntil: 'domcontentloaded' });
    const rawResponse = await page.evaluate(() => document.body.textContent);

    let jsonBody;
    try {
      jsonBody = JSON.parse(rawResponse);
    } catch (error) {
      log(`Error parsing allowlist response: ${error.message}`);
      await page.close();
      return false;
    }

    const isAllowlistEligible = jsonBody.stageIds && jsonBody.stageIds.length > 0;
    await page.close();
    return isAllowlistEligible;
  } catch (error) {
    log(`Error checking allowlist: ${error.message}`);
    await page.close();
    return false;
  }
}

let cachedGasData = null;
async function getDynamicGas(forceRefresh = false) {
  if (!cachedGasData || forceRefresh) {
    const feeData = await provider.getFeeData();
    cachedGasData = {
      maxFeePerGas: feeData.maxFeePerGas.mul(Math.floor(GAS_MULTIPLIER * 100)).div(100),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(Math.floor(GAS_MULTIPLIER * 100)).div(100)
    };
  }
  return cachedGasData;
}

function prepareMintTx({ collectionId, priceWei, protocol, tokenId }) {
  const selector = protocol === 'erc1155' ? '0x9b4f3af5' : '0x9f93f779';
  let calldata;

  if (protocol === 'erc1155') {
    const toPadded = ethers.utils.hexZeroPad(wallet.address, 32).slice(2);
    const idPadded = ethers.utils.hexZeroPad(ethers.utils.hexlify(parseInt(tokenId)), 32).slice(2);
    const amountPadded = ethers.utils.hexZeroPad('0x1', 32).slice(2);
    const dataOffsetPadded = ethers.utils.hexZeroPad('0x80', 32).slice(2);
    const dataLengthPadded = ethers.utils.hexZeroPad('0x0', 32).slice(2);
    calldata = selector + toPadded + idPadded + amountPadded + dataOffsetPadded + dataLengthPadded;
  } else {
    const toPadded = ethers.utils.hexZeroPad(wallet.address, 32).slice(2);
    const amountPadded = ethers.utils.hexZeroPad('0x1', 32).slice(2);
    calldata = selector + toPadded + amountPadded;
  }

  return {
    to: collectionId,
    value: priceWei,
    gasLimit: GAS_LIMIT,
    data: calldata
  };
}

async function prepareAllTransactions({ collectionId, priceWei, protocol, tokenId, mintCount }) {
  const baseNonce = await provider.getTransactionCount(wallet.address, 'pending');
  const gasParams = await getDynamicGas(true);
  const baseTx = prepareMintTx({ collectionId, priceWei, protocol, tokenId });
  
  const preparedTransactions = [];
  
  for (let i = 0; i < mintCount; i++) {
    preparedTransactions.push({
      ...baseTx,
      ...gasParams,
      nonce: baseNonce + i
    });
  }
  
  return preparedTransactions;
}

async function mintOnChain({ collectionId, priceWei, collectionName, protocol, tokenId, mintCount }) {
  log(`Minting ${mintCount} NFTs for ${collectionName}`);

  const gasParams = await getDynamicGas(true);
  const baseNonce = await provider.getTransactionCount(wallet.address, 'pending');
  const baseTx = prepareMintTx({ collectionId, priceWei, protocol, tokenId });

  const transactions = [];
  for (let i = 0; i < mintCount; i++) {
    transactions.push({
      ...baseTx,
      ...gasParams,
      nonce: baseNonce + i
    });
  }

  const txPromises = transactions.map(async (txData, i) => {
    try {
      const txResponse = await wallet.sendTransaction(txData);
      log(`Tx ${i + 1} sent: ${EXPLORER_URL}${txResponse.hash}`);
      return txResponse;
    } catch (error) {
      log(`Tx ${i + 1} failed: ${error.message}`);
      return null;
    }
  });

  await Promise.all(txPromises);
  log(`Minting ${collectionName} completed`);
  await closeBrowser();
  process.exit(0);
}

async function checkMintDetails({ linkType, collections, stages: launchpadStages }) {
  log('Checking mint details');
  let targetCollection = null;

  for (const collection of collections) {
    const { collectionId, collectionName, isMinting, protocol, tokenId } = collection;
    log(`Minting status: ${isMinting} | Protocol: ${protocol}`);

    if (!isMinting) {
      log('Skipping: Minting not active');
      continue;
    }

    let stages;
    if (linkType === 'mint-terminal') {
      stages = await fetchMintTerminalStartTime(collectionId);
    } else if (linkType === 'launchpad') {
      stages = launchpadStages;
    }

    const isAllowlistEligible = await checkAllowlistEligibility(collectionId);
    log(`Allowlist eligibility: ${isAllowlistEligible ? 'Eligible' : 'Not eligible'}`);
    const mintCount = parseInt(await getUserInput(`➤ Enter NFT mint count for ${collectionName}: `));
    if (isNaN(mintCount) || mintCount <= 0) {
      log('Invalid mint count input');
      return null;
    }

    if (!stages) {
      log('Failed to fetch launch time or price, aborting');
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    let selectedStage = null;

    await getDynamicGas(true);

    const allStagesPassed = stages.every(stage => stage.startTime <= now);
    if (allStagesPassed) {
      selectedStage = stages[stages.length - 1];
      log(`All stages passed, using last stage: Start time ${new Date(selectedStage.startTime * 1000).toLocaleString()}, Price: ${ethers.utils.formatEther(selectedStage.priceWei)} MON`);
      targetCollection = { collectionId, priceWei: selectedStage.priceWei, collectionName, protocol, tokenId, mintCount, isAllowlistEligible };
    } else {
      stages.forEach((stage, index) => {
        log(`Stage ${index + 1} - Start time: ${new Date(stage.startTime * 1000).toLocaleString()}, Price: ${ethers.utils.formatEther(stage.priceWei)} MON`);
      });
      const stageChoice = parseInt(await getUserInput(`➤ Select stage to mint (1-${stages.length}): `));
      if (isNaN(stageChoice) || stageChoice < 1 || stageChoice > stages.length) {
        log('Invalid stage selection, aborting');
        return null;
      }
      selectedStage = stages[stageChoice - 1];
      log(`Selected stage ${stageChoice}: Start time ${new Date(selectedStage.startTime * 1000).toLocaleString()}, Price: ${ethers.utils.formatEther(selectedStage.priceWei)} MON`);

      if (selectedStage.startTime > now) {
        const waitMs = (selectedStage.startTime - now) * 1000;
        log(`Preparing for launch in ${waitMs / 1000}s: ${collectionName} at ${new Date(selectedStage.startTime * 1000).toLocaleString()}`);

        const preparedTxs = await prepareAllTransactions({ 
          collectionId, 
          priceWei: selectedStage.priceWei, 
          protocol, 
          tokenId, 
          mintCount 
        });
        log(`${preparedTxs.length} transactions pre-prepared`);

        await new Promise(resolve => {
          setTimeout(async () => {
            await mintOnChain({ 
              collectionId, 
              priceWei: selectedStage.priceWei, 
              collectionName, 
              protocol, 
              tokenId, 
              mintCount 
            });
            resolve();
          }, Math.max(waitMs - 50, 0));
        });

        return null;
      } else {
        log(`Launch time already passed, proceeding immediately: ${collectionName}`);
        targetCollection = { collectionId, priceWei: selectedStage.priceWei, collectionName, protocol, tokenId, mintCount, isAllowlistEligible };
      }
    }
    break;
  }

  if (!targetCollection || !['erc1155', 'erc721'].includes(targetCollection.protocol)) {
    log('Error: No eligible collection or unsupported protocol');
    return null;
  }

  return targetCollection;
}

async function runBot() {
  log('Starting Magic Eden Mint Bot');
  
  try {
    const collectionLink = await getUserInput('➤ Enter Magic Eden collection link: ');
    const fetchResult = await fetchLatestMintsOrLaunchpad(collectionLink);
    if (!fetchResult || !fetchResult.collections.length) {
      log('No collections found');
      await closeBrowser();
      process.exit(0);
      return;
    }

    const { linkType, collections, stages } = fetchResult;
    log(`Detected link type: ${linkType}`);

    const eligibleCollection = await checkMintDetails({ linkType, collections, stages });
    if (eligibleCollection) {
      await mintOnChain(eligibleCollection);
    } else {
      await closeBrowser();
      process.exit(0);
    }
  } catch (error) {
    log(`Bot crashed: ${error.message}`);
    await closeBrowser();
    process.exit(1);
  }
}

runBot();
