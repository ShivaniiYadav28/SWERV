import { Schema, model } from 'mongoose';

const agentAttendanceSchema = new Schema(
  {
    agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },
    attendanceDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    checkInAt: { type: Date, required: true },
    checkOutAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

agentAttendanceSchema.index({ agentId: 1, attendanceDate: 1 }, { unique: true });
agentAttendanceSchema.index(
  { agentId: 1 },
  { unique: true, partialFilterExpression: { checkOutAt: { $type: 'null' } } },
);
agentAttendanceSchema.index({ attendanceDate: -1, checkInAt: -1 });

export const AgentAttendance = model('AgentAttendance', agentAttendanceSchema);
