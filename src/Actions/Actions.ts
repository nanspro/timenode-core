import BigNumber from 'bignumber.js';

import Cache, { ICachedTxDetails } from '../Cache';
import { ILogger } from '../Logger';
import { Address, ITxRequest } from '../Types';
import ITransactionOptions from '../Types/ITransactionOptions';
import W3Util from '../Util';
import { IWalletReceipt, Wallet } from '../Wallet';
import { getAbortedExecuteStatus, isAborted, isExecuted } from './Helpers';
import { ILedger } from './Ledger';
import { Pending } from './Pending';
import { Operation } from '../Types/Operation';
import { TxSendStatus } from '../Enum/TxSendStatus';

export default interface IActions {
  claim(txRequest: ITxRequest, nextAccount: Address, gasPrice: BigNumber): Promise<TxSendStatus>;
  execute(txRequest: ITxRequest, gasPrice: BigNumber): Promise<TxSendStatus>;
}

export default class Actions implements IActions {
  private logger: ILogger;
  private wallet: Wallet;
  private ledger: ILedger;
  private cache: Cache<ICachedTxDetails>;
  private utils: W3Util;
  private pending: Pending;

  constructor(
    wallet: Wallet,
    ledger: ILedger,
    logger: ILogger,
    cache: Cache<ICachedTxDetails>,
    utils: W3Util,
    pending: Pending
  ) {
    this.wallet = wallet;
    this.logger = logger;
    this.ledger = ledger;
    this.cache = cache;
    this.utils = utils;
    this.pending = pending;
  }

  public async claim(
    txRequest: ITxRequest,
    nextAccount: Address,
    gasPrice: BigNumber
  ): Promise<TxSendStatus> {
    const context = TxSendStatus.claim;
    //TODO: merge wallet ifs into 1 getWalletStatus or something
    if (this.wallet.hasPendingTransaction(txRequest.address, Operation.CLAIM)) {
      return TxSendStatus.STATUS(context, 'PROGRESS');
    }
    if (!this.wallet.isAccountAbleToSendTx(nextAccount)) {
      return TxSendStatus.STATUS(context, 'BUSY');
    }
    if (await this.pending.hasPending(txRequest, { type: Operation.CLAIM, checkGasPrice: true })) {
      return TxSendStatus.STATUS(context, 'PENDING');
    }

    try {
      const opts = this.getClaimingOpts(txRequest, gasPrice);
      const { receipt, from, status } = await this.wallet.sendFromAccount(nextAccount, opts);

      this.ledger.accountClaiming(receipt, txRequest, opts, from);

      switch (status) {
        case TxSendStatus.OK:
          this.cache.get(txRequest.address).claimedBy = from;
          return TxSendStatus.STATUS(context, 'SUCCESS');
        case TxSendStatus.WALLET_BUSY:
          return TxSendStatus.STATUS(context, 'BUSY');
        case TxSendStatus.IN_PROGRESS:
          return TxSendStatus.STATUS(context, 'PROGRESS');
        case TxSendStatus.MINED_IN_UNCLE:
          return TxSendStatus.STATUS(context, 'MINED');
      }
    } catch (err) {
      this.logger.error(err);
    }

    return TxSendStatus.STATUS(context, 'FAIL');
  }

  public async execute(txRequest: ITxRequest, gasPrice: BigNumber): Promise<TxSendStatus> {
    const context = TxSendStatus.execute;
    if (this.wallet.hasPendingTransaction(txRequest.address, Operation.EXECUTE)) {
      return TxSendStatus.STATUS(context, 'PROGRESS');
    }
    if (!this.wallet.isNextAccountFree()) {
      return TxSendStatus.STATUS(context, 'BUSY');
    }

    try {
      const opts = this.getExecutionOpts(txRequest, gasPrice);
      const claimIndex = this.wallet.getAddresses().indexOf(txRequest.claimedBy);
      const wasClaimedByOurNode = claimIndex > -1;
      let executionResult: IWalletReceipt;

      if (wasClaimedByOurNode && txRequest.inReservedWindow()) {
        this.logger.debug(
          `Claimed by our node ${claimIndex} and inReservedWindow`,
          txRequest.address
        );
        executionResult = await this.wallet.sendFromIndex(claimIndex, opts);
      } else if (!(await this.hasPendingExecuteTransaction(txRequest))) {
        executionResult = await this.wallet.sendFromNext(opts);
      } else {
        return TxSendStatus.STATUS(context, 'PENDING');
      }

      const { receipt, from, status } = executionResult;

      switch (status) {
        case TxSendStatus.OK:
          await txRequest.refreshData();

          let executionStatus = TxSendStatus.STATUS(context, 'SUCCESS');
          const success = isExecuted(receipt);

          if (success) {
            this.cache.get(txRequest.address).wasCalled = true;
          } else if (isAborted(receipt)) {
            executionStatus = getAbortedExecuteStatus(receipt);
          } else {
            executionStatus = TxSendStatus.STATUS(context, 'FAIL');
          }

          this.ledger.accountExecution(txRequest, receipt, opts, from, success);

          return executionStatus;

        case TxSendStatus.WALLET_BUSY:
          return TxSendStatus.STATUS(context, 'BUSY');
        case TxSendStatus.IN_PROGRESS:
          return TxSendStatus.STATUS(context, 'PROGRESS');
        case TxSendStatus.MINED_IN_UNCLE:
          return TxSendStatus.STATUS(context, 'MINED');
      }
    } catch (err) {
      this.logger.error(err, txRequest.address);
    }

    return TxSendStatus.STATUS(context, 'FAIL');
  }

  public async cleanup(): Promise<boolean> {
    throw Error('Not implemented according to latest EAC changes.');
  }

  private async hasPendingExecuteTransaction(txRequest: ITxRequest): Promise<boolean> {
    return this.pending.hasPending(txRequest, {
      type: Operation.EXECUTE,
      checkGasPrice: true,
      minPrice: txRequest.gasPrice
    });
  }

  private getClaimingOpts(txRequest: ITxRequest, gasPrice: BigNumber): ITransactionOptions {
    return {
      to: txRequest.address,
      value: txRequest.requiredDeposit,
      gas: 120000,
      gasPrice,
      data: txRequest.claimData,
      operation: Operation.CLAIM
    };
  }

  private getExecutionOpts(txRequest: ITxRequest, gasPrice: BigNumber): ITransactionOptions {
    const gas = this.utils.calculateGasAmount(txRequest);

    return {
      to: txRequest.address,
      value: new BigNumber(0),
      gas: gas.toNumber(),
      gasPrice,
      data: txRequest.executeData,
      operation: Operation.EXECUTE
    };
  }
}
