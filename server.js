import TelegramBot from 'node-telegram-bot-api';
import { ChatGPTAPI } from 'chatgpt';
import * as dotenv from 'dotenv';

dotenv.config();

// replace the value below with the Telegram token you receive from @BotFather
if (!process.env.TELEGRAM_TOKEN) {
  console.log('Please set TELEGRAM_TOKEN in your .env file.');
  process.exit(1);
}

const telegramToken = process.env.TELEGRAM_TOKEN;

// ChatGPT OpenAI API Key
if (!process.env.CHATGPT_TOKEN) {
  console.log('Please set CHATGPT_TOKEN in your .env file.');
  process.exit(1);
}

const chatgptToken = process.env.CHATGPT_TOKEN;

// User whitelist - parsed as integer to allow easier comparison with telegram user ids
if (!process.env.ONLY_ALLOW_WHITELISTED_TELEGRAM_IDS) {
  console.log('Please set ONLY_ALLOW_WHITELISTED_TELEGRAM_IDS in your .env file.');
  process.exit(1);
}

if (process.env.ONLY_ALLOW_WHITELISTED_TELEGRAM_IDS === 'true' && !process.env.WHITELISTED_TELEGRAM_IDS) {
  console.log('Please set WHITELISTED_TELEGRAM_IDS in your .env file.');
  process.exit(1);
}

const idsToProcess = process.env.WHITELISTED_TELEGRAM_IDS || '';
const whitelistedTelegramIds = idsToProcess.split(',').map(id => parseInt(id, 10));

// Processing queue to prevent message spam by users
const processingQueueOfUserIds = [];

// Conversation map to keep track of conversations
const conversationIdMap = [];

const getConversationId = (userId) => {
  const foundConversationId = conversationIdMap.find(item => item.userId === userId);

  if (foundConversationId)
    return {
      conversationId: foundConversationId.conversationId,
      parentMessageId: foundConversationId.parentMessageId
    };

  return false;
}

const setConversationId = (userId, conversationId, parentMessageId) => {
  const foundConversationId = conversationIdMap.findIndex(item => item.userId === userId);

  if (foundConversationId >= 0) {
    conversationIdMap[foundConversationId].conversationId = conversationId;
    conversationIdMap[foundConversationId].parentMessageId = parentMessageId;
  } else {
    conversationIdMap.push({
      userId,
      conversationId,
      parentMessageId,
    });
  }
}

// Delete conversation Id from map based on userId
const deleteConversationId = (userId) => {
  const foundConversationId = conversationIdMap.find(item => item.userId === userId);

  if (foundConversationId) {
    conversationIdMap.splice(conversationIdMap.indexOf(foundConversationId), 1);
  }
}

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(telegramToken, { polling: true });

// Initialise ChatGPT API
const chatgptApi = new ChatGPTAPI({
  apiKey: chatgptToken
});

// Listen for all messages
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const isUserWhitelisted = whitelistedTelegramIds.includes(msg.from.id);

  if (process.env.ONLY_ALLOW_WHITELISTED_TELEGRAM_IDS === 'true' && !isUserWhitelisted) {
    bot.sendMessage(chatId, 'Sorry, you are not authorised to use this bot.');
    return;
  }

  // Reset conversation history
  if (msg.text === '/reset') {
    deleteConversationId(msg.from.id);
    bot.sendMessage(chatId, 'Conversation reset. You may now begin a new conversation with me.');
    return;
  }

  // Get conversation ID
  const { conversationId, parentMessageId } = getConversationId(msg.from.id);

  const generateResponse = async () => {
    // Check if there is a message pending processing from ChatGPT
    if (processingQueueOfUserIds.includes(msg.from.id)) {
      bot.sendMessage(chatId, 'ChatGPT is still processing your last message. Please wait for a response before sending another message.');
      return;
    }

    processingQueueOfUserIds.push(msg.from.id);

    let chatgptResponded = false;
    let lastTypingStatus = new Date();

    const chatgptOptions = {
      onProgress: (partialResponse) => {
        // Send typing status to user
        if (chatgptResponded) return

        // Only trigger sendChatAction once every 4 seconds
        const timeElapsed = new Date() - lastTypingStatus;

        if (timeElapsed >= 4000) {
          bot.sendChatAction(chatId, 'typing');
          lastTypingStatus = new Date();
        }
      },
      ...(conversationId && { conversationId }),
      ...(parentMessageId && { parentMessageId }),
    }

    bot.sendChatAction(chatId, 'typing');

    try {
      const chatgptResponse = await chatgptApi.sendMessage(msg.text, chatgptOptions);
      chatgptResponded = true;
  
      // Update conversation ID
      if (!conversationId) {
        setConversationId(msg.from.id, chatgptResponse.conversationId, chatgptResponse.id)
      }
  
      // send a message to the chat with ChatGPT's response
      bot.sendMessage(chatId, chatgptResponse.text);
    } catch(error) {
      const errorMessage = `ChatGPT API Error: ${error.statusCode} ${error.statusText}`;
      bot.sendMessage(chatId, errorMessage);
    }

    // Remove user from processing queue
    processingQueueOfUserIds.splice(processingQueueOfUserIds.indexOf(msg.from.id), 1);
  }

  generateResponse()
});