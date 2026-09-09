# Starx - Cloud Storage Aggregation Service

A cloud storage aggregation service deployed on Cloudflare Workers with D1 database support.

[English](./index.md) | [简体中文](./index_zh-CN.md)

## Features

- File storage and management
- Cloudflare Workers deployment
- D1 database integration
- Responsive web interface
- File preview capabilities
- Multi-storage backend support
- **WebDAV server support** - Access your storages via WebDAV protocol
- **Starx 存储支持** - 通过 WebDAV 协议访问您的存储

## Quick Start

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn package manager
- Cloudflare account with Workers enabled
- Wrangler CLI installed globally: `npm install -g wrangler`

### Installation

1. Clone the repository:

```bash
git clone https://github.com/ooyyh/Cloudflare-Clist.git
cd Cloudflare-Clist
```

2. Install dependencies:

```bash
npm install
```

### Configuration

1. Log in to Cloudflare:

```bash
wrangler login
```

2. Create a D1 database:

```bash
wrangler d1 create clist
```

3. Update the `wrangler.jsonc` file with your specific database ID and environment variables.

### Development

```bash
npm run dev
```

### Building

```bash
npm run build
```

### Deployment

```bash
npm run deploy
```

For GitHub Actions deployment, see [Deployment Guide](./deployment.md).

## Documentation

- [Deployment Guide](./deployment.md)
- [Configuration Reference](./configuration.md)
- [WebDAV Setup](./webdav.md)

## Technologies Used

- React Router v7
- Cloudflare Workers
- Cloudflare D1 Database
- Vite build tool
- TypeScript
- Tailwind CSS

## Support

- GitHub: [https://github.com/ooyyh](https://github.com/ooyyh)
- Email: laowan345@gmail.com

## License

This project is released under the [MIT License](../LICENSE).
