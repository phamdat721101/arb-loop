import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { chatRouter } from './routes/chat';
import { permitRouter } from './routes/permit';
import { memoryRouter } from './routes/memory';
import { skillRouter } from './routes/skill';
import { paymentRouter } from './routes/payment';
import { billingRouter } from './routes/billing';
import { settlementRouter } from './routes/settlement';
import { createRateLimiter } from './middleware/rateLimit';
import { privacyFilter } from './middleware/privacyFilter';
import { analyticsRouter } from './routes/analytics';
import { zamaChatRouter } from './routes/zamaChat';

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());
app.use(privacyFilter);

const chatLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 30 });
const permitLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });

app.use('/chat', chatLimiter, chatRouter);
app.use('/permit', permitLimiter, permitRouter);
app.use('/memory', memoryRouter);
app.use('/skill', skillRouter);
app.use('/payment', paymentRouter);
app.use('/billing', billingRouter);
app.use('/settlement', settlementRouter);
app.use('/analytics', analyticsRouter);
app.use('/zama-chat', chatLimiter, zamaChatRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Agent backend running on port ${PORT}`);
});
