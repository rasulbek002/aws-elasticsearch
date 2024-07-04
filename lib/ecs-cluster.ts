/* External dependencies */
import { CfnOutput, Tags } from "aws-cdk-lib";
import {
  AutoScalingGroup,
  AutoScalingGroupProps,
} from "aws-cdk-lib/aws-autoscaling";
import {
  CfnSecurityGroupIngress,
  IPeer,
  InstanceType,
  LaunchTemplateProps,
  MachineImage,
  Peer,
  Port,
  SecurityGroup,
  UserData,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  AsgCapacityProvider,
  Cluster,
  Compatibility,
  ContainerDefinitionOptions,
  NetworkMode,
  TaskDefinition,
  TaskDefinitionProps,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancedEc2Service,
  ApplicationLoadBalancedEc2ServiceProps,
} from "aws-cdk-lib/aws-ecs-patterns";
import { ApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  ManagedPolicy,
  Policy,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

interface Tag {
  key: string;
  value: string;
}

interface SecurityGroupRule {
  peer: IPeer;
  port: Port;
}

export interface ECSClusterProps {
  clusterName: string;
  ec2Services: customEC2Service[];
  vpc?: Vpc;
}

export interface customEC2Service {
  autoScalingOptions?: Partial<AutoScalingGroupProps>;
  containers: ContainerDefinitionOptions[];
  ec2InlinePolicies?: Policy[];
  ec2ServiceOptions?: Partial<ApplicationLoadBalancedEc2ServiceProps>;
  ec2Tags?: Tag[];
  lauchTemplateOptions?: Partial<LaunchTemplateProps>;
  name: string;
  serviceAccessEntity: SecurityGroupRule;
  taskDefinitionOptions?: Partial<TaskDefinitionProps>;
}

export class ECSCluster extends Construct {
  constructor(scope: Construct, id: string, props: ECSClusterProps) {
    super(scope, id);

    const { clusterName, ec2Services } = props;

    const vpc = props.vpc
      ? props.vpc
      : Vpc.fromLookup(this, (id = "VPC"), { isDefault: true });

    const cluster = new Cluster(this, clusterName, {
      clusterName,
      vpc,
      containerInsights: true,
    });

    ec2Services.forEach(
      ({
        autoScalingOptions,
        containers,
        ec2InlinePolicies,
        ec2ServiceOptions,
        ec2Tags,
        name,
        serviceAccessEntity,
        taskDefinitionOptions,
      }) => {
        // EC2 and auto scaling
        const instanceRole = new Role(this, `${name}EC2Role`, {
          managedPolicies: [
            ManagedPolicy.fromAwsManagedPolicyName(
              "service-role/AmazonEC2ContainerServiceforEC2Role"
            ),
          ],
          assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
        });

        ec2InlinePolicies?.forEach((policy) => {
          instanceRole.attachInlinePolicy(policy);
        });

        const ec2InstanceName = `${name}EC2`;

        const ec2SecurityGroupName = `${ec2InstanceName}SecurityGroup`;

        const ec2SecurityGroup = new SecurityGroup(this, ec2SecurityGroupName, {
          vpc,
          securityGroupName: ec2SecurityGroupName,
        });

        const ami = MachineImage.lookup({
          name: "al2023-ami-ecs-hvm-2023.0.20240625-kernel-6.1-x86_64",
        });

        const autoScalingGroupName = `${name}AutoScalingGroup`;

        const autoScalingGroup = new AutoScalingGroup(
          this,
          autoScalingGroupName,
          {
            vpc,
            securityGroup: ec2SecurityGroup,
            machineImage: ami,
            userData: UserData.forLinux({
              shebang: `#!/bin/bash 
sysctl -w vm.max_map_count=262144`,
            }),
            instanceType: new InstanceType("t2.medium"),
            role: instanceRole,
            autoScalingGroupName,
            desiredCapacity: 0,
            minCapacity: 0,
            maxCapacity: 4,
            ...autoScalingOptions,
          }
        );

        ec2Tags?.forEach((tag) => {
          Tags.of(autoScalingGroup).add(tag.key, tag.value);
        });

        // ECS Capacity provider
        const defaultCapacityProviderName = `${name}CapacityProvider`;

        const capacityProvider = new AsgCapacityProvider(
          this,
          defaultCapacityProviderName,
          {
            autoScalingGroup,
            capacityProviderName: defaultCapacityProviderName,
          }
        );

        cluster.addAsgCapacityProvider(capacityProvider);

        // ECS Task definition
        const taskDefinition = new TaskDefinition(
          this,
          `${name}TaskDefinition`,
          {
            compatibility: Compatibility.EC2,
            executionRole: Role.fromRoleName(
              this,
              "TaskDefinitionExecutionRole",
              "ecsTaskExecutionRole"
            ),
            networkMode: NetworkMode.HOST,
            ...taskDefinitionOptions,
          }
        );

        containers.forEach((container) => {
          taskDefinition.addContainer(
            `${name}${container.containerName}`,
            container
          );
        });

        // LOAD BALANCER
        const loadBalancerName = `${name}LoadBalancer`;

        const loadBalancerSecurityGroupName = `${loadBalancerName}SecurityGroup`;

        const loadBalancerSecurityGroup = new SecurityGroup(
          this,
          loadBalancerSecurityGroupName,
          {
            securityGroupName: loadBalancerSecurityGroupName,
            vpc,
          }
        );

        const loadBalancer = new ApplicationLoadBalancer(
          this,
          loadBalancerName,
          {
            loadBalancerName,
            vpc,
            securityGroup: loadBalancerSecurityGroup,
          }
        );

        const loadBalancerDNSNameExportName = `${loadBalancerName}DNSNameExportName`;

        new CfnOutput(this, loadBalancerDNSNameExportName, {
          exportName: loadBalancerDNSNameExportName,
          value: loadBalancer.loadBalancerDnsName,
        });

        // Secutiry group configuration
        loadBalancerSecurityGroup.addIngressRule(
          serviceAccessEntity.peer,
          serviceAccessEntity.port
        );

        ec2SecurityGroup.addIngressRule(
          Peer.securityGroupId(loadBalancerSecurityGroup.securityGroupId),
          Port.tcp(9200)
        );

        new CfnSecurityGroupIngress(this, `${name}InstanceCommunication9200`, {
          groupId: ec2SecurityGroup.securityGroupId,
          sourceSecurityGroupId: ec2SecurityGroup.securityGroupId,
          ipProtocol: "-1",
          toPort: 9200,
        });

        new CfnSecurityGroupIngress(this, `${name}InstanceCommunication9300`, {
          groupId: ec2SecurityGroup.securityGroupId,
          sourceSecurityGroupId: ec2SecurityGroup.securityGroupId,
          ipProtocol: "-1",
          toPort: 9300,
        });

        // ECS Service with auto-scaling
        const desiredCount = ec2ServiceOptions?.desiredCount ?? 1;

        new ApplicationLoadBalancedEc2Service(
          this,
          `${name}EC2ServiceWithLoadBalancer`,
          {
            serviceName: name,
            capacityProviderStrategies: [
              {
                capacityProvider: capacityProvider.capacityProviderName,
                base: 0,
                weight: 1,
              },
            ],
            cluster,
            taskDefinition,
            publicLoadBalancer: false,
            loadBalancer,
            openListener: false,
            maxHealthyPercent: 100 + 100 / desiredCount,
            minHealthyPercent: 100,
            ...ec2ServiceOptions,
          }
        );
      }
    );
  }
}
