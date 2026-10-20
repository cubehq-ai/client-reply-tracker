# Two services on Railway, from one repo.
#
# Migrations run in the web service only: both would race, and the worker
# starting a few seconds before a column exists is survivable where two
# concurrent migration runs are not.
web: npm run migrate:prod && npm start
worker: npm run start:worker
