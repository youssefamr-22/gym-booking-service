# Booking & Waitlist service

Part of the **Gym Class Booking System** (Group 33, Cloud Computing & Cloud Security 26CSCN29H).
Owner: **Youssef Amr Sayed (248183)**. Team repository (website, shared code, infrastructure, docs): https://github.com/youssef241764/gym-class-booking

## Functions
- F1 Book a seat atomically (DynamoDB transaction, no overbooking)
- F2 Cancel with late-cancel policy and automatic waitlist promotion
- F3 Waitlist join / leave / position
- F4 My bookings and class roster (trainer/admin)
- F5 Reactions to class events + notifications (in-app and Brevo e-mail)

## Endpoints (API Gateway routes, `infra/api-routes.txt`)
- `GET /api/health`
- `POST /api/bookings`
- `GET /api/bookings/mine`
- `GET /api/bookings`
- `DELETE /api/bookings/{bookingId}`
- `POST /api/waitlist`
- `GET /api/waitlist/mine`
- `DELETE /api/waitlist/{classId}`
- `GET /api/notifications/mine`

Contract, roles and status codes: `docs/api-contract.md` in the team repository.

## Folder layout (Labs 4 and 7)
| Path | What it is |
|---|---|
| `app.js` | Builds the Express app (no listen) |
| `server.js` | Runs it on your PC: `npm run dev` → http://localhost:3003 |
| `lambda.js` | The same app on AWS Lambda (handler `lambda.handler`) |
| `routes/bookings.js` | Method + path + who may call it (auth middleware) |
| `controllers/bookings.js` | Reads the request, validates it, calls the services, chooses the status code |
| `services/` | Business rules and DynamoDB access |
| `workers.js` | SQS messages and scheduled jobs |
| `events/` | Saved Lambda test events (Lab 7, Part 6) |
| `requests.http` | REST Client tests on your PC |
| `infra/iam-policy.json` | This service's least-privilege IAM policy |
| `infra/api-routes.txt` | The only routes API Gateway publishes for this service |
| `infra/ssm-policy.json` | Business rules stored in SSM Parameter Store |
| `.env.example` | Settings to copy into `.env` (never commit `.env`) |

**AWS services used:** Lambda, API Gateway, IAM, CloudWatch Logs, DynamoDB `gym-bookings`, `gym-class-seats`, `gym-waitlist`, `gym-notifications`; SQS `gym-booking-events`, `gym-notifications` (+ DLQs); Secrets Manager (Brevo key); SSM `/gym/booking-service/policy`.

## Run it
This repository is used inside the team repository (it needs the shared `gym-shared` package from `../../shared`):
```bash
git clone https://github.com/youssef241764/gym-class-booking.git
cd gym-class-booking
bash infra/get-services.sh      # clones this repo into services/booking-service
npm run install-all
npm run preview                 # on your PC (no Docker)     or:  npm run cloud   (Floci)
```
Only this service: `cd services/booking-service && npm run dev`, `npm run events`, `npm run zip`, and on Floci `bash infra/deploy-backend.sh booking-service` (from the team repository).
