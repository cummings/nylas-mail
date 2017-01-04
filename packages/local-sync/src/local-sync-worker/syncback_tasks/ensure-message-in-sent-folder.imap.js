const {SendmailClient, Errors: {APIError}} = require('isomorphic-core')
const TaskHelpers = require('./task-helpers')
const SyncbackTask = require('./syncback-task')

/**
 * Ensures that sent messages show up in the sent folder.
 *
 * Gmail does this automatically. IMAP needs to do this manually.
 *
 * If we've `sentPerRecipient` that means we've actually sent many
 * messages (on per recipient). Gmail will have automatically created tons
 * of messages in the sent folder. We need to make it look like you only
 * sent 1 message. To do this we, delete all of the messages Gmail
 * automatically created (keyed by the same Meassage-Id header we set),
 * then stuff a copy of the original message in the sent folder.
 */
class EnsureMessageInSentFolderIMAP extends SyncbackTask {
  description() {
    return `EnsureMessageInSentFolder`;
  }

  affectsImapMessageUIDs() {
    return false
  }

  async run(db, imap) {
    const {Message} = db
    const {messageId, sentPerRecipient} = this.syncbackRequestObject().props
    const {account, logger} = imap
    if (!account) {
      throw new APIError('EnsureMessageInSentFolder: Failed, account not available on imap connection')
    }

    const baseMessage = await Message.findById(messageId,
      {include: [{model: db.Folder}, {model: db.Label}]});

    if (!baseMessage) {
      throw new APIError(`Couldn't find message ${messageId} to stuff in sent folder`, 500)
    }

    const {provider} = account
    const {headerMessageId} = baseMessage

    // Gmail automatically creates sent messages when sending, so we
    // delete each of the ones we sent to each recipient in the
    // `SendMessagePerRecipient` task
    //
    // Each participant gets a message, but all of those messages have the
    // same Message-ID header in them. This allows us to find all of the
    // sent messages and clean them up
    if (sentPerRecipient && provider === 'gmail') {
      try {
        await TaskHelpers.deleteGmailSentMessages({db, imap, provider, headerMessageId})
      } catch (err) {
        // Even if this fails, we need to finish attempting to save the
        // baseMessage to the sent folder
        logger.error(err, 'EnsureMessageInSentFolder: Failed to delete Gmail sent messages');
      }
    }

    /**
     * If we've sentPerRecipient that means we need to always re-add the
     * sent base message.
     *
     * Only gmail optimistically creates a sent message for us. We need to
     * to it manually for all other providers
     */
    if (provider !== 'gmail' || sentPerRecipient) {
      const sender = new SendmailClient(account, logger);
      const rawMime = await sender.buildMime(baseMessage);
      await TaskHelpers.saveSentMessage({db, imap, provider, rawMime, headerMessageId})
    }

    return baseMessage.toJSON()
  }
}

module.exports = EnsureMessageInSentFolderIMAP;
