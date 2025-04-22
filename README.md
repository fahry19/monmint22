# Magiceden Monad Script

A bot to automate NFT minting on Magic Eden for the Monad testnet.

## Prerequisites
Before running the script, ensure your system has the necessary dependencies installed:
```sh
sudo apt update && sudo apt install -y gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget
```

## Installation
Clone the repository and install dependencies:
```sh
git clone https://github.com/fahry19/monmint22
```
```sh
cd monmint22
```
```sh
npm install
```

## Configuration
Create a `.env` file in the project root and add your private key:
```sh
PRIVATE_KEY=your_private_key_here
```

## Usage
To start the script, run:
```sh
node mint.js
```
## Dependencies
- [ethers.js](https://www.npmjs.com/package/ethers)
- [puppeteer](https://www.npmjs.com/package/puppeteer)
- [dotenv](https://www.npmjs.com/package/dotenv)

## License
This project is licensed under the MIT License.
