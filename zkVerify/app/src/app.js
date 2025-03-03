const fs = require("fs");
const { zkVerifySession, ZkVerifyEvents } = require("zkverifyjs");
const ethers = require("ethers");
const path = require("path");
require("dotenv").config();


// Add environment validation
const validateEnv = () => {
console.log(process.env.ETH_SECRET_KEY) 
};

async function run() {
  validateEnv(); // Validate environment variables first
  
  const evmAccount = ethers.computeAddress(process.env.ETH_SECRET_KEY);

  const proof = require("./proof.json");

  // Establish a session with zkVerify
  const session = await zkVerifySession
    .start()
    .Custom(process.env.ZKV_RPC_URL)
    .withAccount(process.env.ZKV_SEED_PHRASE);

  const { events, txResults } = await session
    .verify()
    .risc0()
    .waitForPublishedAttestation()
    .execute({
      proofData: {
        proof: proof.proof,
        vk: proof.image_id,
        publicSignals: proof.pub_inputs,
        version: "V1_2", // Mention the R0 version
      },
    });
    const attestationData = JSON.parse(fs.readFileSync(path.join(__dirname, 'attestation.json')));

  let attestationId, leafDigest;
  events.on(ZkVerifyEvents.IncludedInBlock, (eventData) => {
    console.log("Transaction included in block:", eventData);
    attestationId = eventData.attestationId;
    leafDigest = eventData.leafDigest;
    // Handle the event data as needed
  });

  // Listen for the 'finalized' event
  events.on(ZkVerifyEvents.Finalized, (eventData) => {
    console.log("Transaction finalized:", eventData);
    // Handle the event data as needed
  });

  // Handle errors during the transaction process
  events.on("error", (error) => {
    console.error("An error occurred during the transaction:", error);
  });

  // Upon successful publication on zkVerify of the attestation containing the proof, extract:
  // - the attestation id
  // - the leaf digest (i.e. the structured hash of the statement of the proof)
  events.on(ZkVerifyEvents.AttestationConfirmed, async (eventData) => {
    console.log("Attestation Confirmed", eventData);
    const proofDetails = await session.poe(attestationId, leafDigest);
    proofDetails.attestationId = eventData.id;
    fs.writeFileSync(path.join(__dirname, 'attestation.json'), JSON.stringify(proofDetails, null, 2));
    
    // Move the contract interaction logic HERE
    const attestationData = JSON.parse(fs.readFileSync(path.join(__dirname, 'attestation.json')));
    const filterAttestationsById = zkvContract.filters.AttestationPosted(attestationId, null);
    
    let retries = 3;
    let delay = 2000;

    while (retries > 0) {
      try {
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = Math.max(0, currentBlock - 100); // 100 block lookback
        const toBlock = currentBlock;
        
        if (fromBlock > toBlock) {
          [fromBlock, toBlock] = [toBlock, fromBlock];
        }

        const filter = zkvContract.filters.AttestationPosted(attestationId);
        const logs = await zkvContract.queryFilter(filter, fromBlock, toBlock);
        
        if (logs.length > 0) {
          // Process logs
          break;
        }
        
        // If no logs found, wait and retry
        await new Promise(resolve => setTimeout(resolve, delay));
        retries--;
        delay *= 2;
      } catch (error) {
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
        retries--;
        delay *= 2;
      }
    }
  });
  // Retrieve via rpc call:
  // - the merkle proof of inclusion of the proof inside the attestation
  // - the total number of leaves of the attestation merkle tree
  // - the leaf index of our proof
  let merkleProof, numberOfLeaves, leafIndex;
  try {
    const proofDetails = await session.poe(attestationId, leafDigest);
    ({ proof: merkleProof, numberOfLeaves, leafIndex } = await proofDetails);
    console.log(`Merkle proof details`);
    console.log(`\tmerkleProof: ${merkleProof}`);
    console.log(`\tnumberOfLeaves: ${numberOfLeaves}`);
    console.log(`\tleafIndex: ${leafIndex}`);
  } catch (error) {
    console.error("RPC failed:", error);
  }

  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL, null, {
    polling:true,
  });
  const wallet = new ethers.Wallet(process.env.ETH_SECRET_KEY, provider);

  const abiZkvContract = [
    "event AttestationPosted(uint256 indexed attestationId, bytes32 indexed root)",
  ];

  const abiAppContract = [
    "function checkHash(bytes memory _hash,uint256 attestationId, bytes32[] calldata merklePath, uint256 leafCount, uint256 index)",
    "event SuccessfulProofSubmission(address indexed from)",
  ];

  const zkvContract = new ethers.Contract(
    process.env.ETH_ZKVERIFY_CONTRACT_ADDRESS,
    abiZkvContract,
    provider
  );
  const appContract = new ethers.Contract(
    process.env.ETH_APP_CONTRACT_ADDRESS,
    abiAppContract,
    wallet
  );

  const filterAttestationsById = zkvContract.filters.AttestationPosted(
    attestationId,
    null
  );
  zkvContract.once(filterAttestationsById, async (_id, _root) => {
    // After the attestation has been posted on the EVM, send a `proveYouCanFactor42` tx
    // to the app contract, with all the necessary merkle proof details
    const txResponse = await appContract.checkHash(
      proof.pub_inputs,
      attestationData.attestationId,
      attestationData.proof,
      attestationData.numberOfLeaves,
      attestationData.leafIndex
    );
    const { hash } = await txResponse;
    console.log(`Tx sent to EVM, tx-hash ${hash}`);
  });

  const filterAppEventsByCaller =
    appContract.filters.SuccessfulProofSubmission(evmAccount);
    appContract.once(filterAppEventsByCaller, async () => {
    console.log("Proof verified and attestation confirmed!");
  });
}

module.exports = { run };