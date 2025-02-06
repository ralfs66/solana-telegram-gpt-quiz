require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

// Constants
const GROUP_CHAT_ID = -1002346666372;
const SYSTEM_WALLET = 'DSxTpnVVvCQ3egM4SX9Mn8Jfpgg4GWcQBYEAXRvuzxJm';
const QUIZ_INTERVAL = 10 * 60 * 1000; // 10 minutes instead of 3
const MIN_ENTRY_AMOUNT = 0.01; // SOL
const SIGNATURE_CACHE_SIZE = 20;
const CLEANUP_INTERVAL = 30 * 60 * 1000; // Run cleanup every 30 minutes
let currentQuizMessages = [];
let currentQuestion = null;
let currentPlayers = [];

// Add admin constants
const ADMIN_USERNAME = 'RalfsBlockchain';

// Add retry constants
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

// Add CSV file handling with size limit
const SIGNATURES_FILE = 'used_signatures.csv';
const MAX_CSV_LINES = 1000;

// Add game state variables
let currentPrizePool = 0;

// Add highest payout tracking
let highestPayout = 0;

// Initialize OpenAI and Telegram Bot
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Initialize Solana connection
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Initialize bot's wallet from private key array
const BOT_PRIVATE_KEY = JSON.parse(process.env.SOLANA_PRIVATE_KEY);
const botKeypair = Keypair.fromSecretKey(new Uint8Array(BOT_PRIVATE_KEY));

// Add rate limiting helper at the top
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Solana utility functions
async function sendSolana(recipientAddress, amount) {
    try {
        const recipientPublicKey = new PublicKey(recipientAddress);
        const LAMPORTS_PER_SOL = 1000000000;
        const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

        const { blockhash } = await connection.getLatestBlockhash();
        
        const transaction = new Transaction({
            recentBlockhash: blockhash,
            feePayer: botKeypair.publicKey
        }).add(
            SystemProgram.transfer({
                fromPubkey: botKeypair.publicKey,
                toPubkey: recipientPublicKey,
                lamports,
            })
        );

        const signature = await connection.sendTransaction(transaction, [botKeypair]);
        await connection.confirmTransaction(signature);

        return {
            success: true,
            signature,
            amount: `${amount.toFixed(3)} SOL`
        };
    } catch (error) {
        console.error('Solana transfer error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

function getBotPublicKey() {
    return botKeypair.publicKey.toString();
}

// Quiz game functions
async function generateQuestion() {
    const completion = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [{
            role: 'system',
            content: `Generate ONLY a simple trivia question. DO NOT include multiple choice options. DO NOT include the answer.
IMPORTANT: Return ONLY the question with no additional text, no options, and no answers.`
        }],
        max_tokens: 200,
        temperature: 0.9
    });
    return completion.choices[0].message.content;
}

// Function to read signatures from CSV
function readSignaturesFromFile() {
    try {
        if (!fs.existsSync(SIGNATURES_FILE)) {
            return [];
        }
        const data = fs.readFileSync(SIGNATURES_FILE, 'utf8');
        return data.split('\n').filter(line => line.trim());
    } catch (error) {
        console.error('Error reading signatures file:', error);
        return [];
    }
}

// Function to add signature to CSV with size limit
function addSignatureToFile(signature) {
    try {
        let signatures = readSignaturesFromFile();
        signatures.push(signature);
        
        // Keep only the latest 1000 signatures
        if (signatures.length > MAX_CSV_LINES) {
            signatures = signatures.slice(-MAX_CSV_LINES);
        }
        
        // Write back to file
        fs.writeFileSync(SIGNATURES_FILE, signatures.join('\n') + '\n');
    } catch (error) {
        console.error('Error writing signature to file:', error);
    }
}

// Replace isSignatureProcessed function
function isSignatureProcessed(signature) {
    const usedSignatures = readSignaturesFromFile();
    return usedSignatures.includes(signature);
}

// Replace addToSignatureCache function
function addToSignatureCache(signature) {
    addSignatureToFile(signature);
}

// Update getRecentPlayers with fixed amount checking
async function getRecentPlayers() {
    try {
        console.log('Fetching recent players...');
        const signatures = await connection.getSignaturesForAddress(
            new PublicKey(SYSTEM_WALLET),
            { limit: 10 }
        );
        
        console.log('Found signatures:', signatures.length);
        
        const players = new Set();
        for (const sig of signatures) {
            try {
                // Skip if signature was already processed
                if (isSignatureProcessed(sig.signature)) {
                    console.log('Skipping cached signature:', sig.signature);
                    continue;
                }

                // Add delay between RPC calls
                await sleep(1000);

                const tx = await connection.getParsedTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });

                // Cache the signature regardless of transaction type
                addToSignatureCache(sig.signature);

                // Only process valid incoming payments
                if (tx?.meta?.preBalances && tx?.meta?.postBalances) {
                    const transferAmount = (tx.meta.preBalances[0] - tx.meta.postBalances[0]) / 1000000000;
                    console.log('Transfer amount:', transferAmount);
                    
                    // Check if this is an incoming transaction
                    const receiverIndex = tx.transaction.message.accountKeys.findIndex(
                        key => key.pubkey.toString() === SYSTEM_WALLET
                    );
                    
                    if (transferAmount >= MIN_ENTRY_AMOUNT && receiverIndex !== -1) {
                        // Get the sender (first account that's not the receiver)
                        const sender = tx.transaction.message.accountKeys.find(
                            key => key.pubkey.toString() !== SYSTEM_WALLET
                        ).pubkey.toString();
                        
                        console.log('Found valid player:', sender);
                        players.add(sender);
                    }
                }

            } catch (error) {
                if (error.message.includes('429')) {
                    console.log('Rate limited, waiting 2 seconds...');
                    await sleep(2000);
                    continue;
                }
                console.error('Error processing transaction:', error);
                // Still cache signature even if there was an error processing it
                addToSignatureCache(sig.signature);
            }
        }
        
        console.log('Final players list:', Array.from(players));
        return Array.from(players);
    } catch (error) {
        console.error('Error getting recent players:', error);
        return [];
    }
}

// Update helper functions
function formatSolanaAddress(address) {
    return `\`${address}\``;
}

function formatTransaction(signature) {
    return `[View on Solscan ↗](https://solscan.io/tx/${signature})`;
}

// Remove signature-related cleanup from cleanupState
function cleanupState() {
    try {
        console.log('Starting periodic state cleanup...');
        
        // Cleanup quiz messages older than 15 minutes
        const fifteenMinutesAgo = Date.now() - (15 * 60 * 1000);
        currentQuizMessages = currentQuizMessages.filter(msg => 
            msg.timestamp && msg.timestamp > fifteenMinutesAgo
        );

        // Reset state if no activity
        if (!currentQuestion && currentQuizMessages.length === 0) {
            currentPlayers = [];
            global.currentWinner = null;
        }

        console.log('Cleanup complete');
    } catch (error) {
        console.error('Error during state cleanup:', error);
    }
}

// Update sendSolanaWithRetry function
async function sendSolanaWithRetry(walletAddress, amount, retryCount = 0, existingSignature = null) {
    try {
        // If we have an existing signature, check its status first
        if (existingSignature) {
            try {
                const status = await connection.getSignatureStatus(existingSignature);
                
                // If transaction is confirmed or finalized, it's successful
                if (status?.value?.confirmationStatus === 'confirmed' || 
                    status?.value?.confirmationStatus === 'finalized') {
                    console.log('Previous transaction confirmed:', existingSignature);
                    return {
                        success: true,
                        signature: existingSignature
                    };
                }
                
                // If transaction failed (not timeout), stop retrying
                if (status?.value?.err) {
                    console.log('Previous transaction failed:', status.value.err);
                    return {
                        success: false,
                        error: 'Transaction failed'
                    };
                }
            } catch (error) {
                console.error('Error checking transaction status:', error);
            }
        }

        // Only send new transaction if we don't have an existing one
        if (!existingSignature) {
            console.log(`Attempting to send ${amount} SOL to ${walletAddress} (attempt ${retryCount + 1}/5)`);
            const paymentResult = await sendSolana(walletAddress, amount);
            existingSignature = paymentResult.signature;
        }

        // If we haven't reached max retries, wait and check again
        if (retryCount < 4) {
            console.log('Payment pending, checking status in 10 seconds...');
            await sleep(10000);
            return sendSolanaWithRetry(walletAddress, amount, retryCount + 1, existingSignature);
        }

        return {
            success: false,
            error: 'Transaction confirmation timeout'
        };
    } catch (error) {
        console.error(`Error in retry attempt ${retryCount + 1}:`, error);
        
        // Only retry if it's a timeout error
        if (error.message.includes('timeout') && retryCount < 4) {
            console.log('Payment pending, checking status in 5 seconds...');
            await sleep(5000);
            return sendSolanaWithRetry(walletAddress, amount, retryCount + 1, existingSignature);
        }

        return {
            success: false,
            error: error.message
        };
    }
}

// Update message handler to properly collect answers
bot.on('message', async (msg) => {
    try {
        if (msg.chat.id !== GROUP_CHAT_ID) return;
        
        const username = msg.from?.username || msg.from?.first_name || 'Unknown User';
        const text = msg.text || '';

        if (global.currentWinner === username) {
            const walletMatch = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
            if (walletMatch) {
                const walletAddress = walletMatch[0];
                const winnerPrize = currentPrizePool / 2; // 50% of stored prize pool

                await bot.sendMessage(GROUP_CHAT_ID,
                    `💳 Processing payment...\n\n` +
                    `🏆 Winner: @${username}\n` +
                    `📍 To: \`${walletAddress}\`\n\n` +
                    { parse_mode: 'Markdown' }
                );

                try {
                    const paymentResult = await sendSolanaWithRetry(walletAddress, winnerPrize);
                    if (paymentResult.success) {
                        const currentPayout = winnerPrize;
                        if (currentPayout > highestPayout) {
                            highestPayout = currentPayout;
                        }
                        
                        await bot.sendMessage(GROUP_CHAT_ID,
                            `🎊 Congratulations @${username}!\n\n` +
                            `${winnerPrize.toFixed(3)} SOL has been sent to your wallet!\n` +
                            `${currentPayout > highestPayout ? '🎉 New Highest Payout! 🎉\n' : ''}` +
                            `Transaction: ${formatTransaction(paymentResult.signature)}\n\n` +
                            `New game starting in 1 minute...`,
                            { parse_mode: 'Markdown' }
                        );
                        // Clear winner ONLY after successful payment
                        global.currentWinner = null;
                        setTimeout(startNewGame, 60000);
                    } else {
                        await bot.sendMessage(GROUP_CHAT_ID,
                            `⚠️ There seems to be a delay with the payment.\n`
                        );
                    }
                } catch (error) {
                    console.error('Payment error:', error);
                    await bot.sendMessage(GROUP_CHAT_ID, 
                        `⚠️ There seems to be a delay with the payment.\n` 
                    );
                }
            } else {
                await bot.sendMessage(GROUP_CHAT_ID,
                    `@${username}, please provide a valid Solana wallet address to receive your prize.`
                );
            }
        } else if (!text.startsWith('/')) {
            try {
                // Check if user already answered and if we're accepting answers
                const hasAnswered = currentQuizMessages.some(m => m.username === username);
                
                if (!hasAnswered && text.trim().length > 0 && currentQuestion) {
                    currentQuizMessages.push({
                        username: username,
                        text: text.slice(0, 1000),
                        timestamp: Date.now()
                    });
                    console.log(`Added answer from ${username}, total answers: ${currentQuizMessages.length}`);
                    console.log('Current question:', currentQuestion);
                } else {
                    console.log(
                        'Answer not added because:',
                        !currentQuestion ? 'No active question' :
                        hasAnswered ? 'User already answered' :
                        'Empty message'
                    );
                }
            } catch (error) {
                console.error('Error adding quiz message:', error);
            }
        }
    } catch (error) {
        console.error('Error in message handler:', error);
    }
});

// Start periodic cleanup
setInterval(cleanupState, CLEANUP_INTERVAL);

// Add admin check function
function isAdmin(username) {
    return username === ADMIN_USERNAME;
}

// Add command handler
bot.onText(/\/skipwait/, async (msg) => {
    try {
        if (msg.chat.id !== GROUP_CHAT_ID) return;
        
        const username = msg.from?.username;
        
        if (!isAdmin(username)) {
            console.log('Non-admin tried to use /skipwait:', username);
            return;
        }

        console.log('Admin used /skipwait command');
        
        // Clear any existing timeouts
        for (const timeout of Object.keys(global)) {
            if (timeout.startsWith('timeout')) {
                clearTimeout(global[timeout]);
            }
        }

        await bot.sendMessage(GROUP_CHAT_ID, 
            `⏩ Admin @${username} skipped the waiting time.\n` +
            `Starting next phase immediately...`
        );

        // If we're waiting for players, start game immediately
        if (currentPlayers.length === 0) {
            startNewGame();
        }
        // If we're in between game phases, evaluate immediately
        else if (currentQuestion && currentQuizMessages.length > 0) {
            evaluateAndReward();
        }
        // Otherwise, start new game
        else {
            startNewGame();
        }
    } catch (error) {
        console.error('Error in skipwait command:', error);
    }
});

let lastNoPlayersMessage = null;

async function startNewGame() {
    try {
        cleanupState();
        
        const players = await getRecentPlayers();
        
        if (players.length < 2) {
            console.log(`Not enough players (${players.length}/2), checking again in 1 minute...`);
            
            const now = Date.now();
            if (!lastNoPlayersMessage || (now - lastNoPlayersMessage) > 5 * 60 * 1000) {
                await bot.sendMessage(GROUP_CHAT_ID, 
                    `🎮 Welcome to Mindful 8080!\n\n` +
                    `Waiting for more players... (${players.length}/2)\n\n` +
                    `To play, send 0.01 SOL to:\n` +
                    `\`${SYSTEM_WALLET}\`\n\n` +
                    `🏆 Highest Payout: ${highestPayout.toFixed(3)} SOL\n` +
                    `Winner takes 50% of the prize pool! 💰`,
                    { parse_mode: 'Markdown' }
                );
                lastNoPlayersMessage = now;
            }
            
            global.timeoutCheckPlayers = setTimeout(startNewGame, 60 * 1000);
            return;
        }

        currentPrizePool = await connection.getBalance(new PublicKey(getBotPublicKey())) / 1000000000;
        currentPlayers = players;

        await bot.sendMessage(GROUP_CHAT_ID, 
            `🎮 Welcome to Mindful 8080!\n` +
            `Think fast, answer smart, and claim your share of the prize pool! 💰\n\n` +
            `To participate: Send exactly 0.01 SOL to:\n` +
            `\`${SYSTEM_WALLET}\`\n\n` +
            `💸 Current Prize: ${(currentPrizePool/2).toFixed(3)} SOL\n` +
            `🏆 Highest Payout: ${highestPayout.toFixed(3)} SOL\n` +
            `🎯 Current Players (${players.length}):\n${players.map(p => `• ${formatSolanaAddress(p)}`).join('\n')}\n\n` +
            `⏳ Game begins in 1 minute... Brace yourselves!`,
            { parse_mode: 'Markdown' }
        );

        global.timeoutQuestion = setTimeout(async () => {
            const question = await generateQuestion();
            currentQuestion = question;
            currentQuizMessages = [];
            
            await bot.sendMessage(GROUP_CHAT_ID,
                `${question}\n\n` +
                `⏱️ You have 10 minutes to submit your best answer!`
            );

            global.timeoutEvaluate = setTimeout(evaluateAndReward, QUIZ_INTERVAL);
        }, 60000);
    } catch (error) {
        console.error('Error starting new game:', error);
        global.timeoutRetry = setTimeout(startNewGame, 10000);
    }
}

// Update evaluateAndReward to properly handle answers
async function evaluateAndReward() {
    try {
        cleanupState();
        
        console.log('Starting evaluation with:', {
            hasQuestion: !!currentQuestion,
            answersCount: currentQuizMessages?.length || 0,
            currentQuestion,
            answers: currentQuizMessages
        });
        
        if (!currentQuestion || !currentQuizMessages || currentQuizMessages.length === 0) {
            console.log('No answers received yet, keeping the question open');
            await bot.sendMessage(GROUP_CHAT_ID,
                `⏳ No answers yet! The question remains open:\n\n` +
                `❓ ${currentQuestion}\n\n` +
                `🎯 Be the first to answer correctly and win SOL!\n\n` +
                `⏱️ Clock is ticking...`,
                { parse_mode: 'Markdown' }
            );
            global.timeoutEvaluate = setTimeout(evaluateAndReward, QUIZ_INTERVAL);
            return;
        }

        try {
            const evaluation = await openai.chat.completions.create({
                model: "gpt-4-turbo-preview",
                messages: [
                    {
                        role: 'system',
                        content: `You are judging a trivia game. Evaluate if there are any correct answers.
If all answers are incorrect or nonsensical, respond with: NO_WINNER
If there is a correct answer, respond with: WINNER:username

Example good response: WINNER:john123
Example when no correct answers: NO_WINNER

Do not include any other text or explanation.`
                    },
                    {
                        role: 'user',
                        content: `Question: ${currentQuestion}\n\nAnswers:\n${currentQuizMessages.map(m => 
                            `${m.username}: ${(m.text || '').slice(0, 1000)}`).join('\n')}`
                    }
                ],
                temperature: 0.1
            });

            const response = evaluation.choices[0]?.message?.content || '';
            
            if (response.trim() === 'NO_WINNER') {
                await bot.sendMessage(GROUP_CHAT_ID,
                    `🎯 Game Over!\n\n` +
                    `No correct answers were submitted.\n\n` +
                    `Starting new game in 1 minute...`,
                    { parse_mode: 'Markdown' }
                );
                
                setTimeout(startNewGame, 60000);
                return;
            }

            const winnerMatch = response.match(/WINNER:(\S+)/);
            
            if (winnerMatch) {
                const winnerUsername = winnerMatch[1];
                global.currentWinner = winnerUsername;
                const winnerPrize = currentPrizePool / 2; // Exactly 50% of stored prize pool

                // Get winner's answer for explanation
                const winnerAnswer = currentQuizMessages.find(m => m.username === winnerUsername)?.text || '';
                
                // Get explanation
                const explanation = await provideAnswerExplanation(currentQuestion, winnerAnswer);
                
                await bot.sendMessage(GROUP_CHAT_ID,
                    `🎉 Game Over!\n\n` +
                    `👑 Winner: @${winnerUsername}\n` +
                    `📚 ${explanation}\n\n` +
                    `@${winnerUsername}, reply with your Solana wallet address to claim your prize!\n` +
                    `⏳ You have 5 minutes to claim.`,
                    { parse_mode: 'Markdown' }
                );

                // Update winner timeout message
                global.timeoutWinner = setTimeout(() => {
                    if (global.currentWinner === winnerUsername) {
                        global.currentWinner = null;
                        bot.sendMessage(GROUP_CHAT_ID, 
                            `⚠️ Time's up!\n` +
                            `Starting fresh game with new players...`
                        );
                        startNewGame();
                    }
                }, 5 * 60 * 1000);
                return;
            }

            setTimeout(startNewGame, 60000);
        } catch (error) {
            console.error('Error in evaluation:', error);
            setTimeout(startNewGame, 60000);
        }
    } catch (error) {
        console.error('Error in evaluateAndReward:', error);
        setTimeout(startNewGame, 60000);
    }
}

// Add explanation function
async function provideAnswerExplanation(question, winnerAnswer) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-turbo-preview",
            messages: [{
                role: 'system',
                content: `You are providing a brief, educational explanation about a trivia answer.
Return a single paragraph that's informative but concise. Focus on interesting facts related to the correct answer.
Do not mention if the answer was correct or not. Just provide interesting context about the topic.`
            }, {
                role: 'user',
                content: `Question: ${question}\nAnswer given: ${winnerAnswer}`
            }],
            max_tokens: 200,
            temperature: 0.7
        });

        return completion.choices[0].message.content;
    } catch (error) {
        console.error('Error getting explanation:', error);
        return 'Congratulations on the correct answer!'; // Fallback message
    }
}

// Initialize bot and start first game
console.log('Bot starting...');

// Error handler for the bot
bot.on('polling_error', (error) => {
    console.error('Bot polling error:', error);
});

// Add initialization message
bot.on('text', (msg) => {
    if (msg.text === '/start' && isAdmin(msg.from.username)) {
        console.log('Admin initialized bot');
        startNewGame();
    }
});

// Start first game automatically
console.log('Starting first game...');
startNewGame().catch(error => {
    console.error('Error in initial game start:', error);
});

console.log('Bot initialization complete.');