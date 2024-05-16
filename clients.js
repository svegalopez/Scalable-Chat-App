const OpenAI = require("openai");
const { PrismaClient } = require("./prisma/client");

exports.prisma = new PrismaClient();

exports.openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
