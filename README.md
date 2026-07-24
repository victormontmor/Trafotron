# TRAFOTRON — Backend

Backend do TRAFOTRON com banco de dados **PostgreSQL de verdade** (via Neon,
gratuito e permanente). Os dados ficam salvos no banco na nuvem — não dependem
mais de nenhum arquivo no computador que roda o servidor, então nada se perde
se o servidor reiniciar, for redeployado, ou trocar de computador.

## 1. Pré-requisito

Instalar o **Node.js** (versão 18 ou mais nova):
https://nodejs.org (baixe a versão "LTS").

## 2. Criar o banco de dados gratuito (Neon)

1. Acesse **neon.tech** e crie uma conta gratuita (não pede cartão de crédito).
2. Crie um novo projeto (pode aceitar as opções padrão).
3. Na tela do projeto, procure o botão **"Connection string"** (ou "Connect")
   e copie a string que começa com `postgresql://...`.

Guarde essa string — ela é a "senha mestra" de acesso ao banco. Não compartilhe
publicamente (por exemplo, não suba ela para o GitHub).

## 3. Configurar o backend com essa string

Dentro da pasta `trafotron-backend`, faça uma cópia do arquivo `.env.example`
com o nome `.env`, e cole a connection string:

```
DATABASE_URL=postgresql://usuario:senha@ep-exemplo-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
```

(esse é só um exemplo — use a string real que você copiou da Neon)

## 4. Instalar e rodar

Abra um terminal (cmd/PowerShell no Windows, Terminal no Mac) dentro desta
pasta e rode:

```
npm install
npm start
```

Na primeira vez, o próprio servidor cria as tabelas necessárias no banco
automaticamente. Você vai ver algo assim no terminal:

```
=================================================
  TRAFOTRON — servidor rodando (banco Postgres)
=================================================
  Neste computador:  http://localhost:3000
  Em outros computadores da mesma rede: http://192.168.0.15:3000
=================================================
```

- No **próprio computador que roda o servidor**, acesse `http://localhost:3000`.
- Nos **outros computadores/celulares da mesma rede**, acesse o segundo
  endereço mostrado no terminal (o que começa com `192.168...` ou `10....`).

⚠️ Deixe o terminal aberto — se você fechar, o servidor para (mas os dados
continuam salvos no banco, prontos para quando você ligar de novo).

Se aparecer um erro dizendo que `DATABASE_URL` não foi encontrada, é porque o
arquivo `.env` não existe ou está sem a connection string — revise o passo 3.

## 5. Isso funciona fora da minha rede/Wi-Fi?

Do jeito que está (seguindo os passos acima), só funciona entre computadores
conectados à **mesma rede** (mesmo Wi-Fi do escritório, por exemplo). Para
acessar de **qualquer lugar** — de casa, do celular fora do Wi-Fi da empresa —
veja a seção "Colocar na nuvem" logo abaixo.

## 6. Colocar na nuvem (acessar de qualquer lugar)

Vamos usar o **Render** (render.com), que tem um plano gratuito, não pede
cartão de crédito, e é o jeito mais simples de colocar esse tipo de projeto
no ar. O banco de dados (Neon) já está na nuvem desde o passo 2 — aqui só
vamos colocar o servidor (o código) na nuvem também.

### Passo 1 — Colocar o projeto no GitHub

1. Crie uma conta gratuita em **github.com** (se ainda não tiver).
2. Crie um repositório novo (botão verde "New").
3. Suba os arquivos desta pasta para esse repositório. O jeito mais fácil,
   sem usar linha de comando, é:
   - Na página do repositório recém-criado, clique em **"uploading an
     existing file"**.
   - Arraste todos os arquivos desta pasta **exceto** `node_modules` e `.env`
     (o `.env` tem sua senha do banco — nunca suba ele para o GitHub).
   - Clique em "Commit changes".

### Passo 2 — Criar a conta no Render e conectar

1. Crie uma conta gratuita em **render.com** (dá pra entrar direto com a
   conta do GitHub).
2. No painel, clique em **"New +"** → **"Web Service"**.
3. Escolha o repositório que você acabou de criar no GitHub.
4. Preencha:
   - **Name**: `trafotron` (ou o nome que preferir)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. Antes de criar, abra a seção **"Environment Variables"** e adicione:
   - Key: `DATABASE_URL`
   - Value: a mesma connection string da Neon que você usou no `.env`
6. Clique em **"Create Web Service"**.

Em 1 ou 2 minutos, o Render te entrega um endereço fixo, algo como:

```
https://trafotron.onrender.com
```

Esse é o link que você acessa **de qualquer lugar com internet** — casa,
celular, outro escritório — sem precisar de rede local nem terminal aberto.

### O que muda no plano gratuito do Render

- **Ele "dorme" depois de ~15 minutos sem uso.** Na primeira vez que alguém
  acessa depois disso, a página demora de 30 a 60 segundos pra carregar
  enquanto o servidor "acorda". Depois disso fica rápido normalmente.
- **Os dados continuam seguros mesmo assim** — como agora eles ficam no banco
  Postgres da Neon (e não em um arquivo dentro do servidor), reiniciar,
  redeployar ou até recriar o serviço no Render não apaga nada.

### Atualizando depois de mudanças

Sempre que você (ou eu) mudar algo no código, é só subir os arquivos
atualizados no mesmo repositório do GitHub — o Render detecta a mudança e
atualiza o site sozinho em 1-2 minutos. O banco de dados não é afetado.

## 7. Portas e firewall (uso na rede local)

Se um outro computador não conseguir acessar, o motivo mais comum é o
firewall do computador que está rodando o servidor bloqueando a porta 3000.
Libere a porta 3000 para conexões da rede local, ou rode o servidor em outra
porta:

```
PORT=8080 npm start
```

(troque `8080` pela porta que preferir, e ajuste o endereço acessado pelos
outros computadores de acordo)

## 8. Limites do plano gratuito da Neon

- 0,5 GB de armazenamento por projeto — muito mais do que esse app vai usar
  com registros de texto.
- 100 horas de "computação" por mês, com o banco entrando em modo de espera
  (scale-to-zero) quando ninguém usa — ele "acorda" sozinho na próxima
  consulta, sem precisar fazer nada.
- Não expira, não pede cartão de crédito.
