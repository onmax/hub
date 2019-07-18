import { Utf8Tools } from '@nimiq/utils';
import { NetworkClient, DetailedPlainTransaction } from '@nimiq/network-client';
import { SignTransactionRequestLayout } from '@nimiq/keyguard-client';

export const CashlinkExtraData = {
    FUNDING:  new Uint8Array([0, 130, 128, 146, 135]), // 'CASH'.split('').map(c => c.charCodeAt(0) + 63)
    CLAIMING: new Uint8Array([0, 139, 136, 141, 138]), // 'LINK'.split('').map(c => c.charCodeAt(0) + 63)
};

export enum CashlinkType {
    OUTGOING = 0,
    INCOMING = 1,
}

export enum CashlinkState {
    UNKNOWN = -1,
    UNCHARGED = 0, INITIAL = 0,
    CHARGING = 1,
    UNCLAIMED = 2,
    CLAIMING = 3,
    CLAIMED = 4, COMPLETE = 4,
}

export interface CashlinkEntry {
    address: string;
    privateKey: Uint8Array;
    type: CashlinkType;
    value: number;
    message: string;
    state: CashlinkState;
    date: number;
    otherParty?: string; /** originalSender | finalRecipient */
    contactName?: string; /** unused for now */
}

export default class Cashlink {
    get value() {
        return this._value;
    }

    set value(value: number) {
        if (this._immutable) throw new Error('Cashlink is immutable');
        if (!Nimiq.NumberUtils.isUint64(value) || value === 0) throw new Error('Malformed value');
        this._value = value;
    }

    get message() {
        return Utf8Tools.utf8ByteArrayToString(this._messageBytes);
    }

    set message(message) {
        if (this._immutable) throw new Error('Cashlink is immutable');
        const messageBytes = Utf8Tools.stringToUtf8ByteArray(message);
        if (!Nimiq.NumberUtils.isUint8(messageBytes.byteLength)) throw new Error('Message is too long');
        this._messageBytes = messageBytes;
    }

    get address() {
        return this._wallet.address;
    }

    set networkClient(client: NetworkClient) {
        this._networkClientResolver(client);
    }

    public static create(): Cashlink {
        const type = CashlinkType.OUTGOING;
        const privateKey = Nimiq.PrivateKey.generate();
        return new Cashlink(privateKey, type);
    }

    public static parse(str: string): Cashlink | null {
        try {
            str = str.replace(/~/g, '').replace(/=*$/, (match) => new Array(match.length).fill('.').join(''));
            const buf = Nimiq.BufferUtils.fromBase64Url(str);
            const key = Nimiq.PrivateKey.unserialize(buf);
            const value = buf.readUint64();
            let message;
            if (buf.readPos === buf.byteLength) {
                message = '';
            } else {
                const messageLength = buf.readUint8();
                const messageBytes = buf.read(messageLength);
                message = Utf8Tools.utf8ByteArrayToString(messageBytes);
            }

            return new Cashlink(key, CashlinkType.INCOMING, value, message, CashlinkState.UNKNOWN);
        } catch (e) {
            console.error('Error parsing Cashlink:', e);
            return null;
        }
    }

    public static fromObject(object: CashlinkEntry): Cashlink {
        return new Cashlink(
            new Nimiq.PrivateKey(object.privateKey),
            object.type,
            object.value,
            object.message,
            object.state,
            object.date,
            object.otherParty,
            object.contactName,
        );
    }

    private $: Promise<NetworkClient>;
    private _networkClientResolver!: (client: NetworkClient) => void;
    private _wallet: Nimiq.Wallet;
    private _accountRequests: Map<Nimiq.Address, Promise<number>>;
    private _wasEmptied?: boolean;
    private _wasEmptiedRequest: Promise<boolean> | null;
    private _currentBalance: number = 0;
    private _immutable: boolean;
    private _eventListeners: {[type: string]: Array<(data: any) => void>};
    private _messageBytes: Uint8Array = new Uint8Array(0);
    private _value!: number;

    constructor(
        privateKey: Nimiq.PrivateKey,
        public type: CashlinkType,
        value: number = 0,
        message?: string,
        public state: CashlinkState = CashlinkState.INITIAL,
        public date: number = Math.floor(Date.now() / 1000),
        public otherParty?: string, /** originalSender | finalRecipient */
        public contactName?: string, /** unused for now */
    ) {
        this.$ = new Promise((resolve) => {
            this._networkClientResolver = resolve;
        });

        this._wallet = new Nimiq.Wallet(Nimiq.KeyPair.derive(privateKey));

        // for request caching
        this._accountRequests = new Map();
        this._wasEmptiedRequest = null;

        this.value = value;
        if (message) this.message = message;

        this._immutable = !!(value || message);
        this._eventListeners = {};

        this.$.then((network: NetworkClient) => {
            if (this.state !== CashlinkState.COMPLETE) {
                // value will be updated as soon as we have consensus (in _onPotentialBalanceChange)
                // and a confirmed-amount-changed event gets fired
                if (network.consensusState === 'established') {
                    this.getAmount().then((balance: number) => this._currentBalance = balance);
                }

                network.on(NetworkClient.Events.TRANSACTION_PENDING, this._onTransactionAddedOrMined.bind(this));
                network.on(NetworkClient.Events.TRANSACTION_MINED, this._onTransactionAddedOrMined.bind(this));
                network.on(NetworkClient.Events.HEAD_CHANGE, this._onHeadChanged.bind(this));
                network.on(NetworkClient.Events.CONSENSUS_ESTABLISHED, this._onPotentialBalanceChange.bind(this));

                // TODO enable when addSubscriptions is available in NanoApi
                // network.addSubscribtions(wallet.address.toUserFriendlyAddress());
            }
        });
    }

    public toObject(): CashlinkEntry {
        return {
            address: this.address.toUserFriendlyAddress(),
            privateKey: new Uint8Array(this._wallet.keyPair.privateKey.serialize()),
            type: this.type,
            value: this.value,
            message: this.message,
            state: this.state,
            date: this.date,
            otherParty: this.otherParty,
            contactName: this.contactName,
        };
    }

    public render() {
        const buf = new Nimiq.SerialBuffer(
            /*key*/ this._wallet.keyPair.privateKey.serializedSize +
            /*value*/ 8 +
            /*message length*/ (this._messageBytes.byteLength ? 1 : 0) +
            /*message*/ this._messageBytes.byteLength,
        );

        this._wallet.keyPair.privateKey.serialize(buf);
        buf.writeUint64(this._value);
        if (this._messageBytes.byteLength) {
            buf.writeUint8(this._messageBytes.byteLength);
            buf.write(this._messageBytes);
        }

        let result = Nimiq.BufferUtils.toBase64Url(buf);
        // replace trailing . by = because of URL parsing issues on iPhone.
        result = result.replace(/\./g, '=');
        // iPhone also has a problem to parse long words with more then 300 chars in a URL in WhatsApp
        // (and possibly others). Therefore we break the words by adding a ~ every 256 characters in long words.
        result = result.replace(/[A-Za-z0-9_]{257,}/g, (match) => match.replace(/.{256}/g, '$&~'));

        return result;
    }

    public fundingDetails(): {
        layout: SignTransactionRequestLayout,
        recipient: Uint8Array,
        value: number,
        data: Uint8Array,
        message: Uint8Array,
    } {
        return {
            layout: 'cashlink',
            recipient: new Uint8Array(this.address.serialize()),
            value: this.value,
            data: CashlinkExtraData.FUNDING,
            message: this._messageBytes,
        };
    }

    public async claim(
        recipientAddress: string,
        recipientType: Nimiq.Account.Type = Nimiq.Account.Type.BASIC,
        fee = 0,
    ): Promise<void> {
        // Get out the funds. Only the confirmed amount, because we can't request unconfirmed funds.
        const balance = await this._getBalance();
        if (balance === 0) {
            throw new Error('There is no confirmed balance in this link');
        }
        const recipient = Nimiq.Address.fromUserFriendlyAddress(recipientAddress);
        const transaction = new Nimiq.ExtendedTransaction(this._wallet.address, Nimiq.Account.Type.BASIC,
            recipient, recipientType, balance - fee, fee, await this._getBlockchainHeight(),
            Nimiq.Transaction.Flag.NONE, CashlinkExtraData.CLAIMING);
        const keyPair = this._wallet.keyPair;
        const signature = Nimiq.Signature.create(keyPair.privateKey, keyPair.publicKey, transaction.serializeContent());
        const proof = Nimiq.SignatureProof.singleSig(keyPair.publicKey, signature).serialize();
        transaction.proof = proof;
        await this._executeUntilSuccess(async () => {
            await this._sendTransaction(transaction);
        });
    }

    public async getAmount(includeUnconfirmed?: boolean): Promise<number> {
        let balance = await this._getBalance();
        if (includeUnconfirmed) {
            const transferWalletAddress = this._wallet.address;
            for (const transaction of (await this.$).pendingTransactions) {
                const sender = transaction.sender;
                const recipient = transaction.recipient;
                if (recipient === transferWalletAddress.toUserFriendlyAddress()) {
                    // money sent to the transfer wallet
                    balance += transaction.value!;
                } else if (sender === transferWalletAddress.toUserFriendlyAddress()) {
                    balance -= transaction.value! + transaction.fee!;
                }
            }
        }
        return balance;
    }

    public async wasEmptied(): Promise<boolean> {
        if (this._wasEmptied) return true;
        this._wasEmptiedRequest = this._wasEmptiedRequest || this._executeUntilSuccess<boolean>(async () => {
            await this._awaitConsensus();
            const [transactionReceipts, balance] = await Promise.all([
                (await this.$).requestTransactionReceipts(this._wallet.address.toUserFriendlyAddress()),
                this.getAmount(),
            ]);
            // considered emptied if value is 0 and account has been used
            this._wasEmptied = balance === 0 && transactionReceipts.length > 0;
            return this._wasEmptied;
        });
        return this._wasEmptiedRequest;
    }

    public on(type: string, callback: (data: any) => void): void {
        if (!(type in this._eventListeners)) {
            this._eventListeners[type] = [];
        }
        this._eventListeners[type].push(callback);
    }

    public off(type: string, callback: (data: any) => void): void {
        if (!(type in this._eventListeners)) {
            return;
        }
        const index = this._eventListeners[type].indexOf(callback);
        if (index === -1) {
            return;
        }
        this._eventListeners[type].splice(index, 1);
    }

    public fire(type: string, arg: any): void {
        if (!(type in this._eventListeners)) {
            return;
        }
        this._eventListeners[type].forEach((callback) => {
            callback(arg);
        });
    }

    private async _awaitConsensus(): Promise<void> {
        if ((await this.$).consensusState === 'established') return;
        return new Promise(async (resolve, reject) => {
            (await this.$).on(NetworkClient.Events.CONSENSUS_ESTABLISHED, resolve);
            setTimeout(() => reject(new Error('Current network consensus unknown.')), 60 * 1000); // 60 seconds
        });
    }

    private async _sendTransaction(transaction: Nimiq.Transaction): Promise<void> {
        await this._awaitConsensus();
        try {
            const proof = Nimiq.SignatureProof.unserialize(new Nimiq.SerialBuffer(transaction.proof));
            await (await this.$).relayTransaction({
                sender: transaction.sender.toUserFriendlyAddress(),
                senderPubKey: new Uint8Array(proof.publicKey.serialize()),
                recipient: transaction.recipient.toUserFriendlyAddress(),
                value: Nimiq.Policy.lunasToCoins(transaction.value),
                fee: Nimiq.Policy.lunasToCoins(transaction.fee),
                validityStartHeight: transaction.validityStartHeight,
                signature: new Uint8Array(proof.signature.serialize()),
                extraData: transaction.data,
            });
        } catch (e) {
            console.error(e);
            throw new Error('Failed to forward transaction to the network');
        }
    }

    private async _executeUntilSuccess<T>(fn: (...args: any[]) => T | Promise<T>, args: any[] = []): Promise<T> {
        try {
            return await fn.apply(this, args);
        } catch (e) {
            console.error(e);
            return new Promise((resolve) => {
                setTimeout(() => {
                    this._executeUntilSuccess(fn, args).then((result) => resolve(result as T));
                }, 5000);
            });
        }
    }

    private async _getBlockchainHeight(): Promise<number> {
        await this._awaitConsensus();
        return (await this.$).headInfo.height;
    }

    private async _getBalance(address = this._wallet.address): Promise<number> {
        let request = this._accountRequests.get(address);
        if (!request) {
            const headHeight = (await this.$).headInfo.height;
            request = this._executeUntilSuccess<number>(async () => {
                await this._awaitConsensus();
                const balances = await (await this.$).getBalance(address.toUserFriendlyAddress());
                if ((await this.$).headInfo.height !== headHeight && this._accountRequests.has(address)) {
                    // the head changed and there was a new account request for the new head, so we return
                    // that newer request
                    return this._accountRequests.get(address)!;
                } else {
                    // the head didn't change (so everything alright) or we don't have a newer request and
                    // just return the result we got for the older head
                    const balance = balances.get(address.toUserFriendlyAddress()) || 0;
                    if (address.equals(this._wallet.address)) {
                        this._currentBalance = balance;
                    }
                    return balance;
                }
            });
            this._accountRequests.set(address, request);
        }
        return request;
    }

    private async _onTransactionAddedOrMined(transaction: DetailedPlainTransaction): Promise<void> {
        if (transaction.recipient === this._wallet.address.toUserFriendlyAddress()
            || transaction.sender === this._wallet.address.toUserFriendlyAddress()) {
            const amount = await this.getAmount(true);
            this.fire('unconfirmed-amount-changed', amount);
        }
    }

    private async _onHeadChanged(o: {height: number}): Promise<void> {
        // balances potentially changed
        this._accountRequests.clear();
        this._wasEmptiedRequest = null;
        // only interested in final balance
        await this._onPotentialBalanceChange();
    }

    private async _onPotentialBalanceChange(): Promise<void> {
        if ((await this.$).consensusState !== 'established') {
            // only interested in final balance
            return;
        }
        const oldBalance = this._currentBalance;
        const balance = await this.getAmount();

        if (balance !== oldBalance) {
            this.fire('confirmed-amount-changed', balance);
        }
    }
}
